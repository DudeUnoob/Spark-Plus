import assert from "node:assert/strict";
import { test } from "node:test";
import { commit_budget_usage, get_budget_state, reserve_budget_pages } from "./snapshot-storage";

test("query-time budget usage does not increment refresh counters", async () => {
	const storage = new FakeStorage();
	const durable_storage = storage as unknown as DurableObjectStorage;
	const reserved_pages = await reserve_budget_pages(durable_storage, 5);

	assert.equal(reserved_pages, 5);

	const next_state = await commit_budget_usage(durable_storage, {
		actual_pages_used: 3,
		refreshed_at_iso: new Date().toISOString(),
		was_early_refresh: false,
		count_as_refresh: false,
	});

	assert.equal(next_state.pages_used_total, 3);
	assert.equal(next_state.pages_remaining, 497);
	assert.equal(next_state.refresh_count, 0);
	assert.equal(next_state.last_refresh_at, undefined);

	const stored_state = await get_budget_state(durable_storage);
	assert.equal(stored_state.refresh_count, 0);
	assert.equal(stored_state.pages_used_total, 3);
});

test("default commit behavior increments refresh counters", async () => {
	const storage = new FakeStorage();
	const durable_storage = storage as unknown as DurableObjectStorage;
	await reserve_budget_pages(durable_storage, 4);

	const next_state = await commit_budget_usage(durable_storage, {
		actual_pages_used: 2,
		refreshed_at_iso: "2026-03-31T00:00:00.000Z",
		was_early_refresh: false,
	});

	assert.equal(next_state.pages_used_total, 2);
	assert.equal(next_state.refresh_count, 1);
	assert.equal(next_state.last_refresh_at, "2026-03-31T00:00:00.000Z");
});

class FakeStorage {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}
}
