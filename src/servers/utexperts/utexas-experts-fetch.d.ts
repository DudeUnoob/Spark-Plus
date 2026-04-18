export type UTExpertsSearchInput = {
	keyword?: string;
	school?: string;
	lastname?: string;
};

export type UTExpertsPayload = {
	source: string;
	query: { type: string; value: string };
	count: number;
	noResults: boolean;
	researchers: unknown[];
};

export function searchUTExperts(
	input: UTExpertsSearchInput,
): Promise<UTExpertsPayload>;
