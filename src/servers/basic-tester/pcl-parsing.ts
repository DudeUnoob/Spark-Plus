type ReservationData = {
	time: Date;
	room: string;
	availability: "available" | "unavailable";
};

function getReservationDataFromAriaLabel(ariaLabel: string) {
	const regex =
		/^(\d{1,2}:\d{2}(am|pm)) ([^,]+), ([^,]+), (\d{4}) - ([^-]+) - ([^\/]+)\/?.*$/i;
	const match = ariaLabel.match(regex);

	if (!match) {
		console.error(`Invalid ariaLabel format: "${ariaLabel}"`);
		return null;
	}

	const [, timeStr, ampm, weekday, monthDay, year, roomRaw, availabilityRaw] =
		match;

	const dateString = `${timeStr} ${ampm} ${monthDay}, ${year}`;
	const parsedDate = new Date(
		`${monthDay}, ${year} ${timeStr} ${ampm.toUpperCase()}`,
	);
	if (isNaN(parsedDate.getTime())) {
		console.error(`Failed to parse date in ariaLabel: "${ariaLabel}"`);
		return null;
	}

	const room = roomRaw.trim();
	const availability = availabilityRaw
		.trim()
		.toLowerCase()
		.startsWith("unavail")
		? "unavailable"
		: "available";

	return {
		time: parsedDate,
		room,
		availability,
	} as ReservationData;
}
