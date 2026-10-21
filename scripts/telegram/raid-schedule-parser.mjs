const CHANNEL_USERNAME = "raidsMadness";

const REQUIRED_COLUMNS = ["zone", "time", "clan", "boss", "leader", "duration"];

function plainText(value, depth = 0) {
  if (depth > 16 || value == null) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.map((part) => plainText(part, depth + 1)).join("");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if ("text" in value) return plainText(value.text, depth + 1);
  if (Array.isArray(value.texts))
    return value.texts.map((part) => plainText(part, depth + 1)).join("");
  return "";
}

function collectBlocks(blocks, output = []) {
  if (!Array.isArray(blocks)) return output;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    output.push(block);
    collectBlocks(block.blocks, output);
    for (const item of block.items || []) collectBlocks(item?.blocks, output);
  }
  return output;
}

function normaliseHeader(value) {
  return plainText(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/^[^\p{L}\p{N}]+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function columnForHeader(value) {
  const header = normaliseHeader(value);
  if (header === "зона" || header === "зоны") return "zone";
  if (header === "время") return "time";
  if (header === "клан") return "clan";
  if (header === "босс") return "boss";
  if (header.startsWith("ведущ")) return "leader";
  if (header.startsWith("длит")) return "duration";
  return null;
}

function rowCells(row) {
  if (Array.isArray(row)) return row;
  return Array.isArray(row?.cells) ? row.cells : null;
}

function findHeaderMap(row) {
  const cells = rowCells(row);
  if (!cells) return null;
  const columns = {};
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell?.colspan > 1 || cell?.rowspan > 1) return null;
    const name = columnForHeader(typeof cell === "string" ? cell : cell?.text);
    if (!name || name in columns) continue;
    columns[name] = index;
  }
  if (REQUIRED_COLUMNS.some((column) => !(column in columns))) return null;
  return columns;
}

function cellValue(cell) {
  return plainText(typeof cell === "string" ? cell : cell?.text)
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

function rowsFromCells(rows) {
  if (!Array.isArray(rows)) return null;
  const headerIndex = rows.findIndex((row) => findHeaderMap(row));
  if (headerIndex < 0) return null;
  const header = findHeaderMap(rows[headerIndex]);
  const parsed = rows.slice(headerIndex + 1).flatMap((row) => {
    const cells = rowCells(row);
    if (!cells || cells.some((cell) => cell?.colspan > 1 || cell?.rowspan > 1))
      return [];
    const values = Object.fromEntries(
      REQUIRED_COLUMNS.map((column) => [
        column,
        cellValue(cells[header[column]]),
      ]),
    );
    if (!values.time || !values.boss) return [];
    return [values];
  });
  return parsed.length ? parsed : null;
}

function splitTextRow(line) {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  if (line.includes("|"))
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  return null;
}

function rowsFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const rows = lines.map(splitTextRow);
  const headerIndex = rows.findIndex((row) => row && findHeaderMap(row));
  if (headerIndex < 0) return null;
  const header = findHeaderMap(rows[headerIndex]);
  const parsed = rows.slice(headerIndex + 1).flatMap((row) => {
    if (!row || row.every((cell) => /^:?-{2,}:?$/.test(cell))) return [];
    const values = Object.fromEntries(
      REQUIRED_COLUMNS.map((column) => [column, row[header[column]] || ""]),
    );
    if (!values.time || !values.boss) return [];
    return [values];
  });
  return parsed.length ? parsed : null;
}

function tableRows(block) {
  return rowsFromCells(block?.rows || block?.cells);
}

function normaliseDate(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value || "");
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return null;
  return {
    label: `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function findRaidTitle(message, blocks) {
  const candidates = [message?.text];
  for (const block of blocks) {
    const type = block.type || block._;
    if (
      [
        "heading",
        "paragraph",
        "pre",
        "footer",
        "pageBlockTitle",
        "pageBlockHeader",
        "pageBlockSubheader",
        "pageBlockParagraph",
        "pageBlockPreformatted",
        "pageBlockHeading1",
        "pageBlockHeading2",
        "pageBlockHeading3",
        "pageBlockHeading4",
        "pageBlockHeading5",
        "pageBlockHeading6",
      ].includes(type)
    )
      candidates.push(block.text);
  }
  for (const candidate of candidates) {
    const title = plainText(candidate)
      .replace(/\u00a0/g, " ")
      .trim();
    const match =
      /(?:^|[^\p{L}\p{N}_])рейды\s*[—–-]\s*(\d{1,2}\.\d{1,2}\.\d{4})(?![\p{L}\p{N}_])/iu.exec(
        title,
      );
    if (!match) continue;
    const date = normaliseDate(match?.[1]);
    if (date) return { title, date };
  }
  return null;
}

function findTimeZone(message, blocks) {
  const candidates = [message?.text];
  for (const block of blocks) {
    const type = block.type || block._;
    if (
      [
        "paragraph",
        "pre",
        "pageBlockParagraph",
        "pageBlockPreformatted",
      ].includes(type)
    )
      candidates.push(block.text);
  }
  for (const candidate of candidates) {
    const match = /(?:^|\n)\s*время\s*:\s*([^\r\n]+)\s*(?:\r?\n|$)/imu.exec(
      plainText(candidate),
    );
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function toIsoTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseRaidChannelPost(message) {
  const messageId = message?.id ?? message?.message_id;
  if (
    !message ||
    message.isChannelPost !== true ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0
  )
    return null;

  const blocks = collectBlocks(
    message.richMessage?.blocks || message.rich_message?.blocks,
  );
  const title = findRaidTitle(message, blocks);
  if (!title) return null;
  const rows =
    blocks
      .filter((block) => block.type === "table" || block._ === "pageBlockTable")
      .map(tableRows)
      .find(Boolean) || rowsFromText(message.text);
  if (!rows) return null;

  const publishedAt = toIsoTimestamp(message.date);
  const editedAt = toIsoTimestamp(message.editDate ?? message.edit_date);
  return {
    sourceMessageId: String(messageId),
    sourceTitle: title.title,
    raidDate: title.date.key,
    raidDateLabel: title.date.label,
    timeZone: findTimeZone(message, blocks),
    publishedAt,
    editedAt,
    sourceUrl: `https://t.me/${CHANNEL_USERNAME}/${messageId}`,
    raids: rows,
  };
}

export function raidSourceChannelUsername() {
  return CHANNEL_USERNAME;
}
