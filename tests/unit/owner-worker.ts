// The owner's Worker for unit tests: its own code, loaded by path at run time, and a local D1 from wrangler's test
// harness (tests/support/cloud.ts). A static import of the Worker's files would make the tests' type check read Cloudflare's
// runtime types, so the shapes the tests call are typed here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CommentsChange,
	EntryNotes,
	OwnerState,
} from "../../shared/owner-protocol.ts";
import type { Cloud, D1 } from "../support/cloud.ts";
import { startCloud, startWorker, stopCloud } from "../support/cloud.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "worker", "migrations");

// The request's D1 cost counter the Worker's functions take; the tests don't look at it.
type Count = (cost: { rowsRead: number; rowsWritten: number }) => void;

// The refusal worker/src/respond.ts defines for a body a route can't use: its message names the reason, its status is
// what the route answers.
export type BodyProblem = Error & { status: number };

// worker/src/respond.ts as these tests call it.
export type RespondModule = {
	BodyProblem: new (message: string, status?: 400 | 413) => BodyProblem;
	readJson(request: Request, maxBytes: number): Promise<unknown>;
	json(value: unknown, status?: number): Response;
};

// worker/src/owner/checks.ts, store.ts and notes.ts as these tests call them.
type ChecksModule = {
	commentsChangeOf(body: unknown): CommentsChange;
};
type StoreModule = {
	saveComments(db: D1, change: CommentsChange, count: Count): Promise<void>;
};
type NotesModule = {
	readState(db: D1, count: Count): Promise<OwnerState>;
	notesFor(
		db: D1,
		ids: string[],
		count: Count,
	): Promise<Map<string, EntryNotes>>;
};
export type OwnerModule = ChecksModule & StoreModule & NotesModule;

// A Worker file's module, loaded by its path under worker/src.
export async function workerModule<T>(file: string): Promise<T> {
	const loaded: T = await import(
		pathToFileURL(path.join(ROOT, "worker", "src", file)).href
	);
	return loaded;
}

// The cost counter for calls whose cost no test checks.
export const ignoreCost: Count = () => {};

// A started Worker with its D1, and what stops them.
export type OwnerWorker = {
	cloud: Cloud;
	db: D1;
	owner: OwnerModule;
	respond: RespondModule;
	stop: () => Promise<void>;
};

// Start the stand-in for Access and the Worker with its D1 migrated, once; the caller stops it when its file is done.
export async function startOwnerWorker(): Promise<OwnerWorker> {
	const started = await startCloud();
	await startWorker(started.cloud);
	if (started.cloud.db === null) {
		throw new Error("the Worker started with no D1");
	}
	return {
		cloud: started.cloud,
		db: started.cloud.db,
		owner: {
			...(await workerModule<ChecksModule>("owner/checks.ts")),
			...(await workerModule<StoreModule>("owner/store.ts")),
			...(await workerModule<NotesModule>("owner/notes.ts")),
		},
		respond: await workerModule<RespondModule>("respond.ts"),
		stop: () => stopCloud(started.cloud, started.server),
	};
}

// A Worker whose D1 has only the migrations before `migration` (a file name like "0005_thread_highlight.sql"): the
// site as it was stored before that migration. `applyRest` then runs `migration` and the later ones, as a deploy does.
export type WorkerBeforeMigration = {
	db: D1;
	applyRest: () => Promise<void>;
	stop: () => Promise<void>;
};

export async function startWorkerBefore(
	migration: string,
): Promise<WorkerBeforeMigration> {
	const started = await startCloud();
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-migrations-"));
	started.cloud.tempDirs.push(folder);
	started.cloud.migrationsDir = folder;
	const later: string[] = [];
	for (const name of fs.readdirSync(MIGRATIONS).sort()) {
		if (!name.endsWith(".sql")) {
			continue;
		}
		if (name < migration) {
			fs.copyFileSync(path.join(MIGRATIONS, name), path.join(folder, name));
		} else {
			later.push(name);
		}
	}
	await startWorker(started.cloud);
	const { db, harness } = started.cloud;
	if (db === null || harness === null) {
		throw new Error("the Worker started with no D1");
	}
	return {
		db: db,
		applyRest: async () => {
			for (const name of later) {
				fs.copyFileSync(path.join(MIGRATIONS, name), path.join(folder, name));
			}
			await harness.getWorker().applyD1Migrations("DB");
		},
		stop: () => stopCloud(started.cloud, started.server),
	};
}

// Remove every thread and comment, so the next test starts from an empty site.
export async function emptyComments(db: D1): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM comments"),
		db.prepare("DELETE FROM threads"),
	]);
}
