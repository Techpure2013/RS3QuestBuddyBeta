import { ActionIcon, Box, Textarea, Text, Group } from "@mantine/core";
import { useEffect, useState, useCallback, useRef } from "react";
import { IconTrash } from "@tabler/icons-react";
import { useSettings } from "../../Entrance/Entrance Components/SettingsContext";

const STORAGE_KEY = "displayNote";

/**
 * Sanitizes text by escaping HTML special characters to prevent XSS
 * while preserving line breaks for display
 */
const escapeHtml = (text: string): string => {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
};

/**
 * Renders text with line breaks preserved (safe from XSS)
 */
const NoteContent: React.FC<{ text: string; color?: string }> = ({
	text,
	color,
}) => {
	const lines = text.split("\n");
	return (
		<Text
			component="span"
			style={{ color: color || undefined, whiteSpace: "pre-wrap" }}
		>
			{lines.map((line, i) => (
				<span key={i}>
					{escapeHtml(line)}
					{i < lines.length - 1 && <br />}
				</span>
			))}
		</Text>
	);
};

const UserNotes: React.FC = () => {
	const { settings } = useSettings();
	const [noteValue, setNoteValue] = useState<string>("");
	const [displayNote, setDisplayNote] = useState<string[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const hasColor = !!settings.textColor;
	const userColor = settings.textColor || "";

	// Load persisted notes on mount
	useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved) {
				const parsed = JSON.parse(saved);
				if (Array.isArray(parsed)) {
					// Migrate old HTML notes to plain text if needed
					const migrated = parsed.map((note: string) => {
						// Strip common HTML tags from old quill notes
						if (note.includes("<p>") || note.includes("<br>")) {
							return note
								.replace(/<p><br><\/p>/g, "")
								.replace(/<p>/g, "")
								.replace(/<\/p>/g, "\n")
								.replace(/<br\s*\/?>/g, "\n")
								.replace(/<[^>]*>/g, "") // Remove any remaining HTML tags
								.trim();
						}
						return note;
					});
					setDisplayNote(migrated.filter((n: string) => n.length > 0));
				}
			}
		} catch {
			console.warn("Did not find Notes");
		}
	}, []);

	// Persist notes whenever they change
	useEffect(() => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(displayNote));
	}, [displayNote]);

	// Ctrl+S to save current editor content as a note
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.ctrlKey && (event.key === "s" || event.key === "S")) {
				event.preventDefault();
				const savedNoteValue = noteValue.trim();

				if (savedNoteValue) {
					setDisplayNote((prev) => [...prev, savedNoteValue]);
					setNoteValue("");
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [noteValue]);

	const handleNoteChange = useCallback(
		(event: React.ChangeEvent<HTMLTextAreaElement>) => {
			setNoteValue(event.currentTarget.value);
		},
		[],
	);

	const removeNote = useCallback((oneBasedIndex: number) => {
		setDisplayNote((prev) => {
			const idx = oneBasedIndex - 1;
			if (idx < 0 || idx >= prev.length) return prev;
			return prev.slice(0, idx).concat(prev.slice(idx + 1));
		});
	}, []);

	return (
		<>
			<Textarea
				ref={textareaRef}
				className="Notepad"
				placeholder="Type your notes. Press Ctrl+S to save"
				value={noteValue}
				onChange={handleNoteChange}
				minRows={4}
				maxRows={8}
				autosize
				styles={{
					input: {
						color: hasColor ? userColor : undefined,
						backgroundColor: "var(--mantine-color-dark-6)",
					},
				}}
			/>

			<h3 style={{ color: hasColor ? userColor : "" }}>Your Notes</h3>

			{displayNote
				.filter((v) => v && v !== "")
				.map((value, index) => {
					const trueIndex = index + 1;
					return (
						<Box key={trueIndex} className="note" mb="xs">
							<Group justify="space-between" align="flex-start" wrap="nowrap">
								<NoteContent
									text={value}
									color={hasColor ? userColor : undefined}
								/>
								<ActionIcon
									onClick={() => removeNote(trueIndex)}
									size="sm"
									variant="outline"
									color="#CA4D4D"
								>
									<IconTrash />
								</ActionIcon>
							</Group>
						</Box>
					);
				})}
		</>
	);
};

export default UserNotes;
