// D1 statements with their cost counted, for the request's log line: push, the owner routes and the add requests all
// count the same way.

// D1's documented limits: statements per Worker request on the free plan (each statement in a batch counts), and bound
// values per statement.
export const MAX_STATEMENTS = 50;
export const MAX_BOUND_VALUES = 100;

// One D1 statement's cost, as the request's log line counts it.
export type QueryCost = { rowsRead: number; rowsWritten: number };

// The three counts of a request's log line that D1 statements add to.
type CostLog = { queries: number; rowsRead: number; rowsWritten: number };

// Adds each statement's cost to the request's log line.
export function counter(log: CostLog) {
	return (cost: QueryCost) => {
		log.queries += 1;
		log.rowsRead += cost.rowsRead;
		log.rowsWritten += cost.rowsWritten;
	};
}

// Run statements as one batch (one transaction), counting each statement's cost. Rows come back as T.
export async function runBatch<T = Record<string, unknown>>(
	db: D1Database,
	statements: D1PreparedStatement[],
	count: (cost: QueryCost) => void,
): Promise<D1Result<T>[]> {
	const answers = await db.batch<T>(statements);
	for (const answer of answers) {
		count({
			rowsRead: answer.meta.rows_read,
			rowsWritten: answer.meta.rows_written,
		});
	}
	return answers;
}

// Wait for one statement the caller started (with run() or all()), counting its cost.
export async function countOne<T>(
	running: Promise<D1Result<T>>,
	count: (cost: QueryCost) => void,
): Promise<D1Result<T>> {
	const answer = await running;
	count({
		rowsRead: answer.meta.rows_read,
		rowsWritten: answer.meta.rows_written,
	});
	return answer;
}
