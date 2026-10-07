import fsp from "node:fs/promises";
import path from "node:path";

import {
    invalidateArtistCatalog,
    loadArtistCatalogCached,
    peekAnyCachedCatalog,
} from "./artistCatalogCache.mjs";
import {
    invalidateLibraryCache,
    makeAlbumKey,
    scanLibraryOnce,
    stripTrailingYear,
} from "./libraryIndex.mjs";
import {
    filterReleasesByScope,
    normalizeReleaseScope,
} from "./releaseScope.mjs";
import { readSettings } from "./settingsStore.mjs";
import { onEvent as subscribeEvent, emitEvent } from "./eventBus.mjs";

const CONFIG_DIR = process.env.AMDL_CONFIG_DIR || "/config";
const FOLLOWING_FILE = path.join(CONFIG_DIR, "followed-artists.json");

const EMPTY_STORE = {
    version: 1,
    artists: {},
};

// Mutations do a read-modify-write of the whole store file; serialize them so
// a follow, a recompute and the job listeners can't clobber each other with
// stale snapshots.
let writeChain = Promise.resolve();
function serialize(operation) {
    const run = writeChain.then(operation, operation);
    writeChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

export async function readFollowingStore() {
    let raw;
    try {
        raw = await fsp.readFile(FOLLOWING_FILE, "utf8");
    } catch (err) {
        if (err?.code === "ENOENT") return normalizeStore({});
        // Any other read error must not turn into an empty store that the
        // next write would commit over the real one.
        throw err;
    }
    try {
        return normalizeStore(JSON.parse(raw));
    } catch (err) {
        // Keep the corrupt file around for inspection instead of letting
        // the next write silently commit an empty store over it.
        console.error("followed-artists.json unreadable:", err.message);
        await fsp
            .rename(FOLLOWING_FILE, `${FOLLOWING_FILE}.corrupt-${Date.now()}`)
            .catch(() => null);
        return normalizeStore({});
    }
}

async function writeFollowingStore(next) {
    const normalized = normalizeStore(next);
    const tmpFile = `${FOLLOWING_FILE}.tmp`;
    await fsp.writeFile(tmpFile, JSON.stringify(normalized, null, 2), {
        mode: 0o600,
    });
    await fsp.rename(tmpFile, FOLLOWING_FILE);
    return normalized;
}

// Runs fn on a fresh copy of the store and writes the result, one mutation
// at a time. Slow work (catalog fetches, library scans) belongs outside fn.
function mutateFollowingStore(fn) {
    return serialize(async () => {
        const store = await readFollowingStore();
        const result = await fn(store);
        await writeFollowingStore(store);
        return result;
    });
}

export async function listFollowedArtists() {
    const store = await readFollowingStore();
    const artists = Object.values(store.artists).map(projectArtist);
    artists.sort((a, b) => a.name.localeCompare(b.name));
    return artists;
}

export async function getFollowedArtist(id) {
    const store = await readFollowingStore();
    const artist = store.artists[id];
    return artist ? projectArtist(artist) : null;
}

export async function followArtist({
    artistId,
    downloadNow = false,
    releaseScope,
}) {
    const settings = await readSettings();
    const storefront = settings.storefront || "us";
    const language = settings.language || "en-US";
    const catalog = await loadArtistCatalogCached(
        {
            artistId,
            storefront,
            language,
            explicitFilter: settings.explicitFilter || "explicit",
        },
        { force: true },
    );
    if (!catalog?.artist) {
        const err = new Error("artist not found");
        err.statusCode = 404;
        throw err;
    }

    const libIndex = await scanLibraryOnce();
    const now = Date.now();
    const { record, releases } = await mutateFollowingStore((store) => {
        const previous = store.artists[artistId];
        const scope = normalizeReleaseScope(releaseScope || previous?.releaseScope);
        const releases = filterReleasesByScope(catalog.albums, scope);
        const releaseIds = releases.map((album) => album.id).filter(Boolean);
        const knownReleaseIds = Array.from(
            new Set([...(previous?.knownReleaseIds || []), ...releaseIds]),
        );
        const releaseDates = releases
            .map((album) => album.releaseDate)
            .filter(Boolean)
            .sort();
        const latestReleaseDate =
            releaseDates[releaseDates.length - 1] ||
            previous?.latestReleaseDate ||
            null;

        const missingCount = countMissingReleases(releases, libIndex);

        store.artists[artistId] = normalizeArtistRecord({
            ...previous,
            id: artistId,
            name: catalog.artist.name || previous?.name || "Unknown artist",
            genreNames: catalog.artist.genreNames || previous?.genreNames || [],
            url: catalog.artist.url || previous?.url || null,
            artworkTemplate:
                catalog.artist.artworkTemplate ||
                catalog.albums.find((album) => album.artworkTemplate)
                    ?.artworkTemplate ||
                previous?.artworkTemplate ||
                null,
            artworkColor:
                catalog.artist.artworkColor ||
                catalog.albums.find((album) => album.artworkColor)?.artworkColor ||
                previous?.artworkColor ||
                null,
            storefront,
            releaseScope: scope,
            knownReleaseIds,
            latestReleaseDate,
            lastCheckedAt: previous?.lastCheckedAt || now,
            followedAt: previous?.followedAt || now,
            updatedAt: now,
            totalReleaseCount: releases.length,
            missingReleaseCount: missingCount,
        });
        return { record: store.artists[artistId], releases };
    });

    emitEvent("following.updated", {
        artistId,
        missingReleaseCount: record.missingReleaseCount,
        totalReleaseCount: releases.length,
        releaseScope: record.releaseScope,
        followed: true,
    });
    return {
        artist: projectArtist(record),
        albums: releases,
    };
}

export async function recomputeFollowedArtist(id, patch = {}) {
    const settings = await readSettings();
    const store = await readFollowingStore();
    const current = store.artists[id];
    if (!current) return null;
    const scope = normalizeReleaseScope(
        patch.releaseScope || current.releaseScope,
    );
    const catalog = await loadArtistCatalogCached(
        {
            artistId: id,
            storefront: current.storefront || settings.storefront || "us",
            language: settings.language || "en-US",
            explicitFilter: settings.explicitFilter || "explicit",
        },
        { force: true },
    );
    if (!catalog?.artist) return projectArtist(current);

    const releases = filterReleasesByScope(catalog.albums, scope);
    const releaseIds = releases.map((album) => album.id).filter(Boolean);
    const releaseDates = releases
        .map((album) => album.releaseDate)
        .filter(Boolean)
        .sort();
    const libIndex = await scanLibraryOnce();
    const next = await mutateFollowingStore((store) => {
        // Re-read under the lock: the artist may have changed or been
        // unfollowed while the catalog was fetched.
        const fresh = store.artists[id];
        if (!fresh) return null;
        store.artists[id] = normalizeArtistRecord({
            ...fresh,
            ...patch,
            name: catalog.artist.name || fresh.name,
            genreNames: catalog.artist.genreNames || fresh.genreNames,
            url: catalog.artist.url || fresh.url,
            artworkTemplate:
                catalog.artist.artworkTemplate ||
                catalog.albums.find((album) => album.artworkTemplate)
                    ?.artworkTemplate ||
                fresh.artworkTemplate ||
                null,
            artworkColor:
                catalog.artist.artworkColor ||
                catalog.albums.find((album) => album.artworkColor)
                    ?.artworkColor ||
                fresh.artworkColor ||
                null,
            releaseScope: scope,
            knownReleaseIds: Array.from(
                new Set([...(fresh.knownReleaseIds || []), ...releaseIds]),
            ),
            latestReleaseDate:
                releaseDates[releaseDates.length - 1] ||
                fresh.latestReleaseDate ||
                null,
            totalReleaseCount: releases.length,
            missingReleaseCount: countMissingReleases(releases, libIndex),
            updatedAt: Date.now(),
        });
        return store.artists[id];
    });
    if (!next) return null;
    emitEvent("following.updated", {
        artistId: id,
        missingReleaseCount: next.missingReleaseCount,
        totalReleaseCount: next.totalReleaseCount,
        releaseScope: next.releaseScope,
    });
    return projectArtist(next);
}

export async function unfollowArtist(id) {
    const existed = await mutateFollowingStore((store) => {
        const had = Boolean(store.artists[id]);
        delete store.artists[id];
        return had;
    });
    if (existed) {
        invalidateArtistCatalog(id);
        emitEvent("following.updated", { artistId: id, followed: false });
    }
    return { ok: true, existed };
}

export async function updateFollowedArtist(id, patch) {
    return mutateFollowingStore((store) => {
        const current = store.artists[id];
        if (!current) return null;
        store.artists[id] = normalizeArtistRecord({
            ...current,
            ...(typeof patch === "function" ? patch(current) : patch),
            updatedAt: Date.now(),
        });
        return store.artists[id];
    });
}

export function countMissingReleases(releases, libIndex) {
    let missingCount = 0;
    for (const album of releases || []) {
        if (!album.artistName || !album.name) continue;
        const key = makeAlbumKey(
            album.artistName,
            stripTrailingYear(album.name),
        );
        if (!key || !libIndex.albumKeys.has(key)) missingCount++;
    }
    return missingCount;
}

function projectArtist(artist) {
    const total = artist.totalReleaseCount || 0;
    const missing = artist.missingReleaseCount || 0;
    return {
        ...artist,
        releaseScope: normalizeReleaseScope(artist.releaseScope),
        totalReleaseCount: total,
        missingReleaseCount: missing,
        fullyDownloaded: total > 0 && missing === 0,
    };
}

function normalizeStore(parsed) {
    const artists = {};
    for (const [id, artist] of Object.entries(parsed?.artists || {})) {
        const normalized = normalizeArtistRecord({ ...artist, id });
        if (normalized.id) artists[normalized.id] = normalized;
    }
    return {
        ...EMPTY_STORE,
        ...parsed,
        version: 1,
        artists,
    };
}

function normalizeArtistRecord(artist) {
    const id = String(artist?.id || "").trim();
    return {
        id,
        name: String(artist?.name || "Unknown artist"),
        genreNames: Array.isArray(artist?.genreNames)
            ? artist.genreNames.map(String)
            : [],
        url: artist?.url || null,
        artworkTemplate: artist?.artworkTemplate || null,
        artworkColor: artist?.artworkColor || null,
        storefront: String(artist?.storefront || "us"),
        releaseScope: normalizeReleaseScope(artist?.releaseScope),
        knownReleaseIds: Array.from(
            new Set(
                (Array.isArray(artist?.knownReleaseIds)
                    ? artist.knownReleaseIds
                    : []
                ).map(String),
            ),
        ),
        latestReleaseDate: artist?.latestReleaseDate || null,
        lastCheckedAt: Number(artist?.lastCheckedAt || 0),
        followedAt: Number(artist?.followedAt || Date.now()),
        updatedAt: Number(artist?.updatedAt || Date.now()),
        totalReleaseCount: Number(artist?.totalReleaseCount || 0),
        missingReleaseCount: Number(artist?.missingReleaseCount || 0),
    };
}

subscribeEvent(async (evt) => {
    if (!evt || evt.type !== "job.update") return;
    const job = evt.data;
    if (!job || job.status !== "done" || job.kind !== "album" || !job.artistId)
        return;
    try {
        invalidateLibraryCache();
        const store = await readFollowingStore();
        const artist = store.artists[job.artistId];
        if (artist && artist.missingReleaseCount > 0) {
            // Decrement the stored count, not this snapshot's, so two jobs
            // finishing together both count.
            const updated = await updateFollowedArtist(job.artistId, (current) => ({
                missingReleaseCount: Math.max(0, current.missingReleaseCount - 1),
            }));
            if (!updated) return;
            emitEvent("following.updated", {
                artistId: job.artistId,
                missingReleaseCount: updated.missingReleaseCount,
                totalReleaseCount: updated.totalReleaseCount,
                releaseScope: updated.releaseScope,
                albumId: job.albumId,
            });
        }
    } catch (err) {
        console.error(
            "Failed to decrement missingReleaseCount for job",
            job.id,
            err,
        );
    }
});

function normalizeArtistKey(name) {
    return String(name || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

subscribeEvent(async (evt) => {
    if (!evt || evt.type !== "library.changed") return;
    const data = evt.data || {};
    const targetKey = normalizeArtistKey(data.artistName);
    if (!targetKey) return;
    try {
        const store = await readFollowingStore();
        const matches = Object.values(store.artists).filter(
            (a) => normalizeArtistKey(a.name) === targetKey,
        );
        if (matches.length === 0) return;
        const libIndex = await scanLibraryOnce();
        for (const artist of matches) {
            const catalog = peekAnyCachedCatalog(artist.id);
            let nextMissing;
            if (catalog && Array.isArray(catalog.albums)) {
                const releases = filterReleasesByScope(
                    catalog.albums,
                    artist.releaseScope,
                );
                nextMissing = countMissingReleases(releases, libIndex);
            } else if (
                data.kind === "album-deleted" ||
                data.kind === "song-deleted"
            ) {
                nextMissing = Math.min(
                    artist.totalReleaseCount ||
                        (artist.missingReleaseCount || 0) + 1,
                    (artist.missingReleaseCount || 0) + 1,
                );
            } else {
                continue;
            }
            if (nextMissing === artist.missingReleaseCount) continue;
            await updateFollowedArtist(artist.id, {
                missingReleaseCount: nextMissing,
            });
            emitEvent("following.updated", {
                artistId: artist.id,
                missingReleaseCount: nextMissing,
                totalReleaseCount: artist.totalReleaseCount,
                releaseScope: artist.releaseScope,
            });
        }
    } catch (err) {
        console.error("library.changed recompute failed", err);
    }
});
