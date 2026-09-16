package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func Test2FAValidationAndWriting(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "supervisor-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	sup := NewSupervisor("nonexistent-bin", tempDir, []string{"-H", "0.0.0.0"})

	// Test invalid codes
	invalidCodes := []string{"12345", "1234567", "abcdef", "12a456", ""}
	for _, code := range invalidCodes {
		if err := sup.write2faCode(code); err == nil {
			t.Errorf("expected error for code %q, got nil", code)
		}
	}

	// Test valid code
	if err := sup.write2faCode("654321"); err != nil {
		t.Fatalf("failed to write valid code: %v", err)
	}

	filePath := sup.get2faFilePath()
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("failed to read 2fa file: %v", err)
	}
	if string(data) != "654321" {
		t.Errorf("expected file content '654321', got %q", string(data))
	}

	// Test clearing 2FA files
	sup.clear2faFiles()
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Errorf("expected 2fa file to be removed, but stat returned: %v", err)
	}
}

func TestHealthAndStatusEndpoints(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "supervisor-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	sup := NewSupervisor("nonexistent-bin", tempDir, []string{"-H", "0.0.0.0"})

	// Health check
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	sup.handleHealth(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("health endpoint returned status %d, want %d", rr.Code, http.StatusOK)
	}

	var healthResp StatusResponse
	if err := json.NewDecoder(rr.Body).Decode(&healthResp); err != nil {
		t.Fatalf("failed to decode health response: %v", err)
	}
	if !healthResp.Ok {
		t.Errorf("expected health ok=true, got false")
	}

	// Status check
	req = httptest.NewRequest(http.MethodGet, "/status", nil)
	rr = httptest.NewRecorder()
	sup.handleStatus(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("status endpoint returned status %d, want %d", rr.Code, http.StatusOK)
	}
}

func TestTwoFaEndpoint(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "supervisor-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	sup := NewSupervisor("nonexistent-bin", tempDir, []string{"-H", "0.0.0.0"})

	// Invalid method
	req := httptest.NewRequest(http.MethodGet, "/login/2fa", nil)
	rr := httptest.NewRecorder()
	sup.handle2FA(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want %d", rr.Code, http.StatusMethodNotAllowed)
	}

	// Invalid code
	body := bytes.NewBufferString(`{"code":"123"}`)
	req = httptest.NewRequest(http.MethodPost, "/login/2fa", body)
	rr = httptest.NewRecorder()
	sup.handle2FA(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("got %d, want %d", rr.Code, http.StatusBadRequest)
	}

	// Valid code
	body = bytes.NewBufferString(`{"code":"123456"}`)
	req = httptest.NewRequest(http.MethodPost, "/login/2fa", body)
	rr = httptest.NewRecorder()
	sup.handle2FA(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("got %d, want %d", rr.Code, http.StatusOK)
	}

	filePath := sup.get2faFilePath()
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("failed to read 2fa file: %v", err)
	}
	if string(data) != "123456" {
		t.Errorf("expected 123456, got %q", string(data))
	}
}

func TestLoginStreaming(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "supervisor-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a mock wrapper script
	mockScript := filepath.Join(tempDir, "mock_wrapper.sh")
	scriptContent := `#!/bin/sh
echo "[+] logging in..."
echo "[.] response type 4"
echo "account info cached successfully"
`
	if err := os.WriteFile(mockScript, []byte(scriptContent), 0755); err != nil {
		t.Fatalf("failed to create mock script: %v", err)
	}

	sup := NewSupervisor(mockScript, tempDir, []string{"-H", "0.0.0.0"})

	body := bytes.NewBufferString(`{"email":"test@example.com","password":"secret"}`)
	req := httptest.NewRequest(http.MethodPost, "/login", body)
	rr := httptest.NewRecorder()

	sup.handleLogin(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 OK, got %d: %s", rr.Code, rr.Body.String())
	}

	output := rr.Body.String()
	if !strings.Contains(output, "[+] logging in...") {
		t.Errorf("missing expected log line in output: %s", output)
	}
	if !strings.Contains(output, "account info cached successfully") {
		t.Errorf("missing success log line in output: %s", output)
	}
}
