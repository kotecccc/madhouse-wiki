import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  departmentCardFilename,
  floorCardFilename,
  unavailableBusinessCardFilename,
} from "./inline-card-assets.mjs";
import { renderBusinessUpgradeCards } from "./inline-business-card-renderer.mjs";
import { renderBossOpeningCards } from "./inline-boss-card-renderer.mjs";

const WIDTH = 1200;

function tokenMapFromCss(css) {
  const tokens = {};
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function resolveToken(tokens, name) {
  let value = tokens[name] || "";
  for (let pass = 0; pass < 8; pass += 1) {
    const next = value.replace(/var\((--[\w-]+)\)/gu, (_, reference) => {
      return tokens[reference] || "";
    });
    if (next === value) break;
    value = next;
  }
  return value;
}

function tokenPixels(tokens, name) {
  const value = resolveToken(tokens, name);
  const match = /^([\d.]+)(px|rem)$/u.exec(value);
  if (!match)
    throw new Error(`Expected a spacing or font-size token for ${name}`);
  const amount = Number(match[1]);
  return match[2] === "rem" ? amount * 16 : amount;
}

function tokenNumber(tokens, name) {
  const value = Number(resolveToken(tokens, name));
  if (!Number.isFinite(value))
    throw new Error(`Expected a numeric token for ${name}`);
  return value;
}

function getTheme(root) {
  const css = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8");
  const tokens = tokenMapFromCss(css);
  const textColor = (name) => {
    const value = resolveToken(tokens, name);
    if (!value) throw new Error(`Missing design token ${name}`);
    return value;
  };
  return {
    background: textColor("--bg"),
    cardBackground: textColor("--card-background"),
    cardBorder: textColor("--card-border"),
    titleColor: textColor("--card-title-color"),
    descriptionColor: textColor("--card-description-color"),
    fontFamily: textColor("--sans"),
    mediumWeight: tokenNumber(tokens, "--font-weight-medium"),
    semiboldWeight: tokenNumber(tokens, "--font-weight-semibold"),
    boldWeight: tokenNumber(tokens, "--font-weight-bold"),
    radius: tokenPixels(tokens, "--card-radius"),
    padding: tokenPixels(tokens, "--card-padding"),
    contentGap: tokenPixels(tokens, "--card-content-gap"),
    outerPadding: tokenPixels(tokens, "--space-24"),
    outerMargin: tokenPixels(tokens, "--space-32"),
    titleSize: tokenPixels(tokens, "--font-size-2xl"),
    bodySize: tokenPixels(tokens, "--font-size-lg"),
    noteSize: tokenPixels(tokens, "--font-size-sm"),
    lineHeight: tokenNumber(tokens, "--card-line-height"),
  };
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapText(value, maximumCharacters) {
  const words = String(value ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!words.length) return [""];

  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length <= maximumCharacters) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function textElement(text, x, y, size, color, weight, anchor, fontFamily) {
  return `<text x="${x}" y="${y}" font-family="${xml(fontFamily)}" font-size="${size}" font-weight="${weight}" fill="${xml(color)}" text-anchor="${anchor}">${xml(text)}</text>`;
}

function drawTextLines(
  lines,
  x,
  baseline,
  size,
  color,
  lineHeight,
  weight,
  fontFamily,
) {
  return lines
    .map((line, index) =>
      textElement(
        line,
        x,
        baseline + index * lineHeight,
        size,
        color,
        weight,
        "start",
        fontFamily,
      ),
    )
    .join("");
}

function frameStart(height, theme) {
  const margin = theme.outerMargin;
  const width = WIDTH;
  const cardWidth = width - margin * 2;
  return {
    width,
    height,
    margin,
    cardWidth,
    cardX: margin,
    contentX: margin + theme.outerPadding,
    contentWidth: cardWidth - theme.outerPadding * 2,
    body: `<rect width="${width}" height="${height}" fill="${xml(theme.background)}"/><rect x="${margin}" y="${margin}" width="${cardWidth}" height="${height - margin * 2}" rx="${theme.radius}" fill="${xml(theme.cardBackground)}" stroke="${xml(theme.cardBorder)}"/>`,
  };
}

function renderCardSvg({ title, subtitle, rows, notes = [] }, theme) {
  const top = theme.outerMargin + theme.outerPadding;
  const contentX = theme.outerMargin + theme.outerPadding;
  const contentWidth = WIDTH - theme.outerMargin * 2 - theme.outerPadding * 2;
  const rowPadding = theme.padding;
  const headerTitleY = top + theme.titleSize;
  const subtitleY = headerTitleY + theme.contentGap + theme.bodySize;
  const bodyStartY = subtitleY + theme.outerPadding;
  const itemWidth = contentWidth;
  const itemX = contentX;
  const inset = rowPadding;
  const smallMaxCharacters = Math.floor(
    (itemWidth - inset * 2) / (theme.noteSize * 0.57),
  );
  const rowParts = [];
  let y = bodyStartY;
  for (const row of rows.length
    ? rows
    : [{ label: "В каталоге нет данных об условиях открытия." }]) {
    const amountWidth = row.amount
      ? row.amount.length * theme.bodySize * 0.57 + theme.contentGap
      : 0;
    const labelWidth = itemWidth - inset * 2 - amountWidth;
    const labelMaxCharacters = Math.floor(labelWidth / (theme.bodySize * 0.57));
    const lines = wrapText(row.label, labelMaxCharacters);
    const detailLines = row.detail
      ? wrapText(row.detail, smallMaxCharacters)
      : [];
    const lineHeight = theme.bodySize * theme.lineHeight;
    const detailLineHeight = theme.noteSize * theme.lineHeight;
    const rowHeight =
      rowPadding * 2 +
      lines.length * lineHeight +
      (detailLines.length
        ? theme.contentGap + detailLines.length * detailLineHeight
        : 0);
    rowParts.push(
      `<rect x="${itemX}" y="${y}" width="${itemWidth}" height="${rowHeight}" rx="${theme.radius}" fill="${xml(theme.cardBackground)}" stroke="${xml(theme.cardBorder)}"/>`,
    );
    rowParts.push(
      drawTextLines(
        lines,
        itemX + inset,
        y + rowPadding + theme.bodySize,
        theme.bodySize,
        theme.titleColor,
        lineHeight,
        row.strong === false ? theme.mediumWeight : theme.semiboldWeight,
        theme.fontFamily,
      ),
    );
    if (row.amount) {
      rowParts.push(
        textElement(
          row.amount,
          itemX + itemWidth - inset,
          y + rowPadding + theme.bodySize,
          theme.bodySize,
          theme.titleColor,
          theme.boldWeight,
          "end",
          theme.fontFamily,
        ),
      );
    }
    if (detailLines.length) {
      rowParts.push(
        drawTextLines(
          detailLines,
          itemX + inset,
          y +
            rowPadding +
            lines.length * lineHeight +
            theme.contentGap +
            theme.noteSize,
          theme.noteSize,
          theme.descriptionColor,
          detailLineHeight,
          theme.mediumWeight,
          theme.fontFamily,
        ),
      );
    }
    y += rowHeight + theme.contentGap;
  }

  const noteGroups = notes.flatMap((note) =>
    wrapText(note, smallMaxCharacters),
  );
  const notePadding = rowPadding;
  if (noteGroups.length) {
    const noteLineHeight = theme.noteSize * theme.lineHeight;
    const noteHeight = notePadding * 2 + noteGroups.length * noteLineHeight;
    rowParts.push(
      `<rect x="${itemX}" y="${y}" width="${itemWidth}" height="${noteHeight}" rx="${theme.radius}" fill="${xml(theme.cardBackground)}" stroke="${xml(theme.cardBorder)}"/>`,
      drawTextLines(
        noteGroups,
        itemX + inset,
        y + notePadding + theme.noteSize,
        theme.noteSize,
        theme.descriptionColor,
        noteLineHeight,
        theme.mediumWeight,
        theme.fontFamily,
      ),
    );
    y += noteHeight;
  }

  const bottom = theme.outerMargin + theme.outerPadding;
  const height = Math.ceil(y + bottom);
  const frame = frameStart(height, theme);
  const heading = [
    textElement(
      title,
      frame.contentX,
      headerTitleY,
      theme.titleSize,
      theme.titleColor,
      theme.boldWeight,
      "start",
      theme.fontFamily,
    ),
    textElement(
      subtitle,
      frame.contentX,
      subtitleY,
      theme.bodySize,
      theme.descriptionColor,
      theme.mediumWeight,
      "start",
      theme.fontFamily,
    ),
  ].join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="0 0 ${frame.width} ${frame.height}">${frame.body}${heading}${rowParts.join("")}</svg>`;
}

function sourceNotes(knowledgeBase, conditions, openingText) {
  const sourceIds = new Set(
    conditions.map((condition) => condition.sourceId).filter(Boolean),
  );
  const userProvided = (knowledgeBase.sources || []).some(
    (source) =>
      sourceIds.has(source.id) &&
      source.kind === "user-provided" &&
      source.verification === "provided-by-user; not-api-verified",
  );
  const notes = [];
  if (userProvided) {
    notes.push(
      "Часть условий взята из пользовательской подборки и не подтверждена API.",
    );
  }
  if (openingText) notes.push(`Примечание каталога: ${openingText}`);
  for (const condition of conditions) {
    if (condition.note) notes.push(String(condition.note));
    if (condition.verification && condition.verification !== "verified") {
      notes.push(`Проверка: ${condition.verification}`);
    }
  }
  return [...new Set(notes)];
}

function floorCard(floor, knowledgeBase, theme) {
  const conditions = Array.isArray(floor.openingConditions)
    ? floor.openingConditions
    : [];
  return renderCardSvg(
    {
      title: `Этаж ${floor.code}`,
      subtitle: "Условия открытия этажа",
      rows: conditions.map((condition) => ({
        label: condition.label || "Условие не указано",
      })),
      notes: sourceNotes(knowledgeBase, conditions, floor.openingConditionText),
    },
    theme,
  );
}

function departmentCard(department, knowledgeBase, theme) {
  const floor = knowledgeBase.floors.find(
    (candidate) => candidate.id === department.floorId,
  );
  const conditions = Array.isArray(department.openingConditions)
    ? department.openingConditions
    : [];
  return renderCardSvg(
    {
      title: `Отделение ${department.code}`,
      subtitle: [department.name, floor ? `этаж ${floor.code}` : null]
        .filter(Boolean)
        .join(" • "),
      rows: conditions.map((condition) => ({
        label: condition.label || "Условие не указано",
      })),
      notes: sourceNotes(knowledgeBase, conditions),
    },
    theme,
  );
}

function unavailableBusinessCard(business, theme) {
  return renderCardSvg(
    {
      title: business?.title || "Бизнес",
      subtitle: "Требования к улучшению",
      rows: [
        {
          label:
            "В пользовательской таблице каталога нет требований для этого уровня.",
        },
      ],
      notes: [
        "Состав затрат неизвестен; данные не выводятся по дропам или неполным записям.",
      ],
    },
    theme,
  );
}

async function jpeg(svg) {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

export async function generateInlineCards(knowledgeBase, root) {
  const theme = getTheme(root);
  const cards = [];
  const bossOpeningCards = await renderBossOpeningCards(knowledgeBase, root);
  const businessUpgradeCards = await renderBusinessUpgradeCards(
    knowledgeBase,
    root,
  );
  const bossOpeningFilenames = new Set(
    bossOpeningCards.map((card) => card.filename),
  );
  for (const floor of knowledgeBase.floors || []) {
    const filename = floorCardFilename(floor.code);
    if (!bossOpeningFilenames.has(filename)) {
      cards.push({
        filename,
        buffer: await jpeg(floorCard(floor, knowledgeBase, theme)),
      });
    }
  }
  for (const department of knowledgeBase.departments || []) {
    const filename = departmentCardFilename(department.code);
    if (!bossOpeningFilenames.has(filename)) {
      cards.push({
        filename,
        buffer: await jpeg(departmentCard(department, knowledgeBase, theme)),
      });
    }
  }
  cards.push({
    filename: unavailableBusinessCardFilename,
    buffer: await jpeg(unavailableBusinessCard(null, theme)),
  });
  cards.push(...bossOpeningCards);
  cards.push(...businessUpgradeCards);
  return cards;
}
