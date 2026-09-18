export const MAX_NAME_LENGTH = 120;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiCharacter = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

export function isSingleEmoji(value) {
  return typeof value === "string" && value.length <= 32 && [...graphemes.segment(value)].length === 1 && emojiCharacter.test(value);
}

export function formatTitle(name, emoji = "") {
  return emoji ? `${emoji} ${name}` : name;
}

export function nameParts(record) {
  if (typeof record?.name === "string") return { name: record.name, emoji: record.emoji || "" };
  const title = typeof record?.title === "string" ? record.title : "";
  const first = [...graphemes.segment(title)][0]?.segment || "";
  const remaining = title.slice(first.length).trim();
  // Older records only have a title. Recognise a leading complete emoji without duplicating it.
  return isSingleEmoji(first) && remaining ? { name: remaining, emoji: first } : { name: title, emoji: "" };
}

export function createNameRecord(input) {
  const parts = typeof input.name === "string" ? { name: input.name, emoji: input.emoji || "" } : nameParts(input);
  const name = parts.name.trim();
  const emoji = typeof parts.emoji === "string" ? parts.emoji.trim() : parts.emoji;
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001F\u007F]/u.test(name)) throw new Error(`请输入 1–${MAX_NAME_LENGTH} 个字符的单行名称。`);
  if (emoji && !isSingleEmoji(emoji)) throw new Error("请选择或粘贴一个完整的 Emoji 表情。");
  return { name, emoji, title: formatTitle(name, emoji) };
}
