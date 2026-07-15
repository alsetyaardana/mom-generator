// Generates a Porta-branded "Minutes of Meeting" (MOM) .docx matching the
// reference FRM-SLS-03 template: logo + FORM/MINUTES OF MEETING header block,
// info grid (Date/Project/Attachments/Venue/Minutes taken by/Attendee/
// Distribution List/Agenda), and a List/Actions table (No./Actionee/Due Date).
//
// Vendored from the porta-mom-generator skill (scripts/generate_mom.js).
// Only change from the original: LOGO_PATH resolves alongside this file
// instead of ../assets/porta-logo.png.
//
// Usage: node generate_mom.js <data.json> <output.docx>

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, VerticalAlign, AlignmentType,
  ImageRun, HeightRule, TableLayoutType,
} = require("docx");

const [, , dataPath, outputPath] = process.argv;
if (!dataPath || !outputPath) {
  console.error("Usage: node generate_mom.js <data.json> <output.docx>");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
const LOGO_PATH = path.join(__dirname, "porta-logo.png");

// ---- shared style constants (matched to the reference template) ----
const GREY = "D9D9D9";           // label cells in the info table + List/Actions header
const LABEL_SHADE = "D9D9D9";    // info-table label column shading (Date, Project:, etc.)
const DIST_VALUE_SHADE = "D8D8D8"; // Distribution List value cell ("Attendees" block)
const LIST_COL_SHADE = "F8F9FA"; // List column background (every row, per reference)
const WHITE = "FFFFFF";          // No./Actionee/Due Date columns (every row, per reference)
const FONT = "Calibri";

const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const allBorders = {
  top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder,
};
const noBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

function textCell({
  text = "", bold = false, italic = false, size = 20, shading = null,
  width = null, verticalAlign = VerticalAlign.CENTER, alignment = AlignmentType.LEFT,
  colSpan = 1, rowSpan = 1, borders = allBorders, margins = null,
}) {
  const lines = Array.isArray(text) ? text : [text];
  return new TableCell({
    width: width ? { size: width, type: WidthType.DXA } : undefined,
    shading: shading ? { type: ShadingType.CLEAR, fill: shading, color: "auto" } : undefined,
    verticalAlign,
    columnSpan: colSpan > 1 ? colSpan : undefined,
    rowSpan: rowSpan > 1 ? rowSpan : undefined,
    borders,
    margins: margins || { top: 40, bottom: 40, left: 80, right: 80 },
    children: lines.map((line) => new Paragraph({
      alignment,
      children: [new TextRun({ text: line, bold, italics: italic, size, font: FONT })],
    })),
  });
}

function bulletCell({ title, bullets, width, shading = null }) {
  const paras = [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 20, font: FONT })],
      spacing: { after: 40 },
    }),
  ];
  for (const b of bullets) {
    paras.push(new Paragraph({
      children: [new TextRun({ text: `-   ${b}`, size: 20, font: FONT })],
      indent: { left: 200 },
    }));
  }
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: shading ? { type: ShadingType.CLEAR, fill: shading, color: "auto" } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: allBorders,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: paras,
  });
}

// ---- 1. Header form table (logo | FORM/MINUTES OF MEETING | Nomor/Revisi/Tanggal) ----
const logoBuffer = fs.readFileSync(LOGO_PATH);

const headerTable = new Table({
  width: { size: 9771, type: WidthType.DXA },
  columnWidths: [2653, 4142, 1170, 1845],
  layout: TableLayoutType.FIXED,
  rows: [
    new TableRow({
      children: [
        new TableCell({
          width: { size: 2653, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          rowSpan: 3,
          borders: allBorders,
          margins: { top: 100, bottom: 100, left: 100, right: 100 },
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new ImageRun({ data: logoBuffer, type: "png", transformation: { width: 156, height: 35 } })],
          })],
        }),
        textCell({ text: "FORM", bold: true, size: 24, width: 4142, alignment: AlignmentType.CENTER, rowSpan: 2 }),
        textCell({ text: "Nomor", bold: true, size: 20, width: 1170 }),
        textCell({ text: data.form_number || "FRM-SLS-03", size: 20, width: 1845 }),
      ],
    }),
    new TableRow({
      children: [
        textCell({ text: "Revisi", bold: true, size: 20, width: 1170 }),
        textCell({ text: data.revision || "00", size: 20, width: 1845 }),
      ],
    }),
    new TableRow({
      children: [
        textCell({ text: "MINUTES OF MEETING", bold: true, size: 24, width: 4142, alignment: AlignmentType.CENTER }),
        textCell({ text: "Tanggal", bold: true, size: 20, width: 1170 }),
        textCell({ text: data.form_date || "", size: 20, width: 1845 }),
      ],
    }),
  ],
});

// ---- 2. Info / Attendee / Distribution / Agenda table ----
const LABEL_W = 2196, VAL_W = 1140, COMPANY_W = 3347, SIG_W = 3112;
const FULL_W = LABEL_W + VAL_W + COMPANY_W + SIG_W; // 9795

function infoRow(label, value) {
  return new TableRow({
    children: [
      textCell({ text: label, bold: true, size: 20, width: LABEL_W, shading: LABEL_SHADE }),
      textCell({ text: value || "", size: 20, width: VAL_W + COMPANY_W + SIG_W, colSpan: 3 }),
    ],
  });
}

const attendeeHeaderRow = new TableRow({
  children: [
    textCell({ text: "Attendee:", bold: true, size: 20, width: LABEL_W + VAL_W, colSpan: 2, shading: LABEL_SHADE }),
    textCell({ text: "Company:", bold: true, size: 20, width: COMPANY_W, shading: LABEL_SHADE }),
    textCell({ text: "Signature:", bold: true, size: 20, width: SIG_W, shading: LABEL_SHADE }),
  ],
});

const attendeeRows = (data.attendees || []).map((a) => new TableRow({
  children: [
    textCell({ text: a.name || "", size: 20, width: LABEL_W + VAL_W, colSpan: 2 }),
    textCell({ text: a.company || "", size: 20, width: COMPANY_W }),
    textCell({ text: "", size: 20, width: SIG_W }),
  ],
}));
// keep at least one trailing blank row for extra signatures, matching template feel
attendeeRows.push(new TableRow({
  children: [
    textCell({ text: "", size: 20, width: LABEL_W + VAL_W, colSpan: 2 }),
    textCell({ text: "", size: 20, width: COMPANY_W }),
    textCell({ text: "", size: 20, width: SIG_W }),
  ],
}));

const distributionRow = new TableRow({
  children: [
    textCell({ text: "Distribution List:", bold: true, italic: true, size: 20, width: LABEL_W, shading: LABEL_SHADE }),
    new TableCell({
      width: { size: VAL_W + COMPANY_W + SIG_W, type: WidthType.DXA },
      columnSpan: 3,
      borders: allBorders,
      shading: { type: ShadingType.CLEAR, fill: DIST_VALUE_SHADE, color: "auto" },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [
        new Paragraph({ children: [new TextRun({ text: "Attendees", bold: true, size: 20, font: FONT })] }),
        ...(data.distribution_list || []).map((d) => new Paragraph({
          children: [new TextRun({ text: d, size: 20, font: FONT })],
        })),
      ],
    }),
  ],
});

const agendaLabelRow = new TableRow({
  children: [
    textCell({ text: "Agenda:", bold: true, size: 20, width: FULL_W, colSpan: 4, shading: LABEL_SHADE }),
  ],
});
const agendaValueRow = new TableRow({
  children: [
    textCell({ text: data.agenda || "", size: 20, width: FULL_W, colSpan: 4 }),
  ],
});

const infoTable = new Table({
  width: { size: FULL_W, type: WidthType.DXA },
  columnWidths: [LABEL_W, VAL_W, COMPANY_W, SIG_W],
  layout: TableLayoutType.FIXED,
  rows: [
    infoRow("Date", data.date),
    infoRow("Project:", data.project),
    infoRow("Attachments:", data.attachments),
    infoRow("Venue:", data.venue),
    infoRow("Minutes taken by:", data.minutes_taken_by),
    attendeeHeaderRow,
    ...attendeeRows,
    distributionRow,
    agendaLabelRow,
    agendaValueRow,
  ],
});

// ---- 3. List / Actions table ----
const LIST_W = 6511, NO_W = 567, ACTIONEE_W = 1276, DUE_W = 1417;
const LIST_FULL_W = LIST_W + NO_W + ACTIONEE_W + DUE_W;

const listActionsHeader1 = new TableRow({
  tableHeader: true,
  children: [
    textCell({ text: "List", bold: true, size: 22, width: LIST_W, shading: GREY, alignment: AlignmentType.CENTER, rowSpan: 2 }),
    textCell({ text: "Actions", bold: true, size: 22, width: NO_W + ACTIONEE_W + DUE_W, colSpan: 3, shading: GREY, alignment: AlignmentType.CENTER }),
  ],
});
const listActionsHeader2 = new TableRow({
  tableHeader: true,
  children: [
    textCell({ text: "No.", bold: true, size: 20, width: NO_W, shading: GREY, alignment: AlignmentType.CENTER }),
    textCell({ text: "Actionee", bold: true, size: 20, width: ACTIONEE_W, shading: GREY, alignment: AlignmentType.CENTER }),
    textCell({ text: "Due Date", bold: true, size: 20, width: DUE_W, shading: GREY, alignment: AlignmentType.CENTER }),
  ],
});

function buildItemRows(items, startNo) {
  // Matches the reference template: the "List" column is always shaded pale
  // grey (LIST_COL_SHADE); No./Actionee/Due Date are always plain white —
  // this is a per-column pattern, not an alternating-row stripe.
  return items.map((item, idx) => new TableRow({
    children: [
      bulletCell({ title: item.title, bullets: item.bullets || [], width: LIST_W, shading: LIST_COL_SHADE }),
      textCell({ text: String(startNo + idx), size: 20, width: NO_W, shading: WHITE, alignment: AlignmentType.CENTER }),
      textCell({ text: item.actionee || "", size: 20, width: ACTIONEE_W, shading: WHITE, alignment: AlignmentType.CENTER }),
      textCell({ text: item.due_date || "-", size: 20, width: DUE_W, shading: WHITE, alignment: AlignmentType.CENTER }),
    ],
  }));
}

const listItems = data.list_items || [];
const todoItems = data.todo_items || [];
const listRows = buildItemRows(listItems, 1);
const todoRows = buildItemRows(todoItems, listItems.length + 1);

const listActionsTable = new Table({
  width: { size: LIST_FULL_W, type: WidthType.DXA },
  columnWidths: [LIST_W, NO_W, ACTIONEE_W, DUE_W],
  layout: TableLayoutType.FIXED,
  rows: [listActionsHeader1, listActionsHeader2, ...listRows, ...todoRows],
});

// ---- assemble document ----
const doc = new Document({
  sections: [
    {
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter (matches template's ~9771 dxa content width incl. margins)
          margin: { top: 720, bottom: 720, left: 900, right: 900 },
        },
      },
      children: [
        headerTable,
        new Paragraph({ text: "", spacing: { after: 120 } }),
        infoTable,
        new Paragraph({ text: "", spacing: { after: 240 } }),
        listActionsTable,
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outputPath, buffer);
  console.log(`Written: ${outputPath}`);
});
