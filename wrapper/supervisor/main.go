package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

var codeRegex = regexp.MustCompile(`^\d{6}$`)

type Mode string

const (
	ModeIdle      Mode = "idle"
	ModeNormal    Mode = "normal"
	ModeLoggingIn Mode = "logging_in"
)

type Supervisor struct {
	mu             sync.Mutex
	wrapperBin     string
	wrapperDataDir string
	normalArgs     []string
	mode           Mode
	normalCmd      *exec.Cmd
	loginCmd       *exec.Cmd
	loginCancel    context.CancelFunc
	collectedLogs  strings.Builder
	subscribers    map[chan string]struct{}
	loginListeners map[chan string]struct{}
	stopping       bool
	lastLoginErr   string
	// Track consecutive clean exits for exponential backoff
	cleanExitCount int
	lastStartTime  time.Time
}

func NewSupervisor(wrapperBin, wrapperDataDir string, normalArgs []string) *Supervisor {
	return &Supervisor{
		wrapperBin:     wrapperBin,
		wrapperDataDir: wrapperDataDir,
		normalArgs:     normalArgs,
		mode:           ModeIdle,
		subscribers:    make(map[chan string]struct{}),
		loginListeners: make(map[chan string]struct{}),
	}
}

func (s *Supervisor) get2faFilePath() string {
	return filepath.Join(s.wrapperDataDir, "data", "com.apple.android.music", "files", "2fa.txt")
}

func (s *Supervisor) clear2faFiles() {
	target := s.get2faFilePath()
	dir := filepath.Dir(target)
	candidates := []string{
		target,
		filepath.Join(dir, ".2fa.txt.tmp"),
		filepath.Join(s.wrapperDataDir, "2fa.txt"),
		filepath.Join(s.wrapperDataDir, ".2fa.txt.tmp"),
	}
	for _, p := range candidates {
		_ = os.Remove(p)
	}
}

func (s *Supervisor) write2faCode(code string) error {
	code = strings.TrimSpace(code)
	if !codeRegex.MatchString(code) {
		return errors.New("2FA code must be exactly 6 digits")
	}
	target := s.get2faFilePath()
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create 2fa directory: %w", err)
	}

	tmpFile := filepath.Join(dir, fmt.Sprintf(".2fa.txt.%d.%d.tmp", os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(tmpFile, []byte(code), 0600); err != nil {
		return fmt.Errorf("failed to write temporary 2fa file: %w", err)
	}
	if err := os.Rename(tmpFile, target); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("failed to commit 2fa file: %w", err)
	}
	return nil
}

func (s *Supervisor) broadcastLog(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.collectedLogs.WriteString(line + "\n")
	for ch := range s.subscribers {
		select {
		case ch <- line:
		default:
		}
	}
	for ch := range s.loginListeners {
		select {
		case ch <- line:
		default:
		}
	}
}

func (s *Supervisor) StartNormal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping || s.mode == ModeLoggingIn {
		return
	}
	if s.normalCmd != nil && s.normalCmd.Process != nil {
		return
	}

	cmd := exec.Command(s.wrapperBin, s.normalArgs...)
	cmd.Env = os.Environ()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("[supervisor] error creating stdout pipe for normal wrapper: %v", err)
		return
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		log.Printf("[supervisor] failed to start wrapper: %v", err)
		return
	}

	s.normalCmd = cmd
	s.mode = ModeNormal
	s.lastStartTime = time.Now()
	log.Printf("[supervisor] normal wrapper started with PID %d", cmd.Process.Pid)

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			text := scanner.Text()
			log.Printf("[wrapper] %s", text)
			s.broadcastLog(text)
		}

		err := cmd.Wait()
		s.mu.Lock()
		s.normalCmd = nil
		stopping := s.stopping
		mode := s.mode
		s.mu.Unlock()

		if stopping {
			return
		}

		if mode == ModeLoggingIn {
			// Normal process stopped because login was requested
			return
		}

		exitCode := 0
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}

		log.Printf("[supervisor] normal wrapper exited with code %d", exitCode)

		s.mu.Lock()
		uptime := time.Since(s.lastStartTime)
		s.mode = ModeIdle

		if exitCode == 0 {
			// Clean exit — likely no credentials yet, or session ended.
			// Use exponential backoff for consecutive clean exits to
			// avoid a tight restart loop, but always restart so the
			// wrapper comes back when credentials are supplied.
			if uptime > 30*time.Second {
				// Ran for a meaningful duration → reset backoff
				s.cleanExitCount = 0
			}
			s.cleanExitCount++
			delay := time.Duration(5<<(s.cleanExitCount-1)) * time.Second
			if delay > 60*time.Second {
				delay = 60 * time.Second
			}
			s.mu.Unlock()
			log.Printf("[supervisor] wrapper exited cleanly, restarting in %s...", delay)
			time.Sleep(delay)
		} else {
			s.cleanExitCount = 0
			s.mu.Unlock()
			log.Printf("[supervisor] wrapper crashed, restarting in 3s...")
			time.Sleep(3 * time.Second)
		}
		s.StartNormal()
	}()
}

func (s *Supervisor) stopNormalLocked() {
	if s.normalCmd != nil && s.normalCmd.Process != nil {
		proc := s.normalCmd.Process
		log.Printf("[supervisor] stopping normal wrapper (PID %d)...", proc.Pid)
		_ = proc.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() {
			_ = s.normalCmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			log.Printf("[supervisor] normal wrapper did not stop in 3s; sending SIGKILL")
			_ = proc.Kill()
		}
		s.normalCmd = nil
	}
}

func (s *Supervisor) CancelLogin() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mode != ModeLoggingIn {
		return nil
	}
	log.Printf("[supervisor] cancelling active sign-in")
	if s.loginCancel != nil {
		s.loginCancel()
	}
	if s.loginCmd != nil && s.loginCmd.Process != nil {
		_ = s.loginCmd.Process.Kill()
	}
	s.clear2faFiles()
	s.mode = ModeIdle
	go s.StartNormal()
	return nil
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type TwoFaRequest struct {
	Code string `json:"code"`
}

type StatusResponse struct {
	Ok           bool     `json:"ok"`
	Mode         string   `json:"mode"`
	Running      bool     `json:"running"`
	LastLoginErr string   `json:"lastLoginErr,omitempty"`
	RecentLogs   []string `json:"recentLogs,omitempty"`
}

func (s *Supervisor) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	mode := string(s.mode)
	running := (s.normalCmd != nil && s.normalCmd.Process != nil) ||
		(s.loginCmd != nil && s.loginCmd.Process != nil)
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(StatusResponse{
		Ok:      true,
		Mode:    mode,
		Running: running,
	})
}

func (s *Supervisor) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	mode := string(s.mode)
	running := (s.normalCmd != nil && s.normalCmd.Process != nil) ||
		(s.loginCmd != nil && s.loginCmd.Process != nil)
	lastErr := s.lastLoginErr
	lines := strings.Split(s.collectedLogs.String(), "\n")
	if len(lines) > 50 {
		lines = lines[len(lines)-50:]
	}
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(StatusResponse{
		Ok:           true,
		Mode:         mode,
		Running:      running,
		LastLoginErr: lastErr,
		RecentLogs:   lines,
	})
}

func (s *Supervisor) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}
	if req.Email == "" || req.Password == "" {
		http.Error(w, "email and password are required", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	if s.mode == ModeLoggingIn {
		s.mu.Unlock()
		http.Error(w, "A sign-in is already in progress", http.StatusConflict)
		return
	}

	s.mode = ModeLoggingIn
	s.stopNormalLocked()
	s.clear2faFiles()
	s.collectedLogs.Reset()
	s.lastLoginErr = ""

	ctx, cancel := context.WithCancel(context.Background())
	s.loginCancel = cancel

	loginArg := fmt.Sprintf("%s:%s", req.Email, req.Password)
	cmd := exec.CommandContext(ctx, s.wrapperBin, "-L", loginArg, "-F", "-H", "0.0.0.0")
	cmd.Env = os.Environ()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.mode = ModeIdle
		cancel()
		s.mu.Unlock()
		http.Error(w, fmt.Sprintf("Failed to initialize login pipe: %v", err), http.StatusInternalServerError)
		go s.StartNormal()
		return
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		s.mode = ModeIdle
		cancel()
		s.mu.Unlock()
		http.Error(w, fmt.Sprintf("Failed to start login process: %v", err), http.StatusInternalServerError)
		go s.StartNormal()
		return
	}

	s.loginCmd = cmd
	logCh := make(chan string, 100)
	s.loginListeners[logCh] = struct{}{}
	s.mu.Unlock()

	log.Printf("[supervisor] login process started with PID %d", cmd.Process.Pid)

	// Stream response back chunked
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Transfer-Encoding", "chunked")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	flusher, canFlush := w.(http.Flusher)

	// Goroutine to read command stdout and feed listeners
	loginDone := make(chan struct{})
	go func() {
		defer close(loginDone)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			text := scanner.Text()
			s.broadcastLog(text)
			if strings.Contains(strings.ToLower(text), "account info cached successfully") {
				log.Printf("[supervisor] login succeeded: account info cached successfully")
			}
		}

		err := cmd.Wait()
		if err != nil {
			log.Printf("[supervisor] login process exited: %v", err)
		} else {
			log.Printf("[supervisor] login process completed cleanly")
		}

		s.mu.Lock()
		s.loginCmd = nil
		s.clear2faFiles()
		s.mode = ModeIdle
		cancel()
		s.mu.Unlock()

		go s.StartNormal()
	}()

	// Feed client from logCh until login completes or client disconnects
	for {
		select {
		case line, ok := <-logCh:
			if !ok {
				return
			}
			_, _ = fmt.Fprintf(w, "%s\n", line)
			if canFlush {
				flusher.Flush()
			}
		case <-loginDone:
			// Drain remaining logs
			for {
				select {
				case line := <-logCh:
					_, _ = fmt.Fprintf(w, "%s\n", line)
					if canFlush {
						flusher.Flush()
					}
				default:
					s.mu.Lock()
					delete(s.loginListeners, logCh)
					s.mu.Unlock()
					return
				}
			}
		case <-r.Context().Done():
			s.mu.Lock()
			delete(s.loginListeners, logCh)
			s.mu.Unlock()
			return
		}
	}
}

func (s *Supervisor) handle2FA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req TwoFaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if err := s.write2faCode(req.Code); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	log.Printf("[supervisor] 2FA code committed to %s", s.get2faFilePath())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (s *Supervisor) handleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	_ = s.CancelLogin()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (s *Supervisor) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan string, 100)
	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.subscribers, ch)
		s.mu.Unlock()
	}()

	notify := r.Context().Done()
	for {
		select {
		case line := <-ch:
			_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
			flusher.Flush()
		case <-notify:
			return
		}
	}
}

func (s *Supervisor) Stop() {
	s.mu.Lock()
	s.stopping = true
	if s.loginCancel != nil {
		s.loginCancel()
	}
	if s.loginCmd != nil && s.loginCmd.Process != nil {
		_ = s.loginCmd.Process.Kill()
	}
	s.stopNormalLocked()
	s.clear2faFiles()
	s.mu.Unlock()
}

func main() {
	port := flag.Int("port", 40020, "Port for supervisor HTTP control server")
	host := flag.String("host", "0.0.0.0", "Host for supervisor HTTP control server")
	wrapperBin := flag.String("wrapper", "/app/wrapper", "Path to wrapper binary")
	dataDir := flag.String("data", "/app/rootfs/data", "Path to wrapper data dir")
	flag.Parse()

	if envPort := os.Getenv("SUPERVISOR_PORT"); envPort != "" {
		var p int
		if _, err := fmt.Sscanf(envPort, "%d", &p); err == nil && p > 0 {
			*port = p
		}
	}
	if envBin := os.Getenv("WRAPPER_BIN"); envBin != "" {
		*wrapperBin = envBin
	}
	if envData := os.Getenv("WRAPPER_DATA_DIR"); envData != "" {
		*dataDir = envData
	}

	normalArgs := flag.Args()
	if len(normalArgs) == 0 {
		normalArgs = []string{"-H", "0.0.0.0"}
	}

	sup := NewSupervisor(*wrapperBin, *dataDir, normalArgs)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", sup.handleHealth)
	mux.HandleFunc("/status", sup.handleStatus)
	mux.HandleFunc("/login", sup.handleLogin)
	mux.HandleFunc("/login/2fa", sup.handle2FA)
	mux.HandleFunc("/login/cancel", sup.handleCancel)
	mux.HandleFunc("/login/events", sup.handleEvents)

	server := &http.Server{
		Addr:    fmt.Sprintf("%s:%d", *host, *port),
		Handler: mux,
	}

	// Catch shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigCh
		log.Printf("[supervisor] shutting down...")
		sup.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	// Start normal wrapper on boot
	sup.StartNormal()

	log.Printf("[supervisor] HTTP control server listening on %s:%d", *host, *port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[supervisor] server error: %v", err)
	}
}
