interface CsvRecord {
  line: number;
  fields: string[];
}

export function readCsv(
  csv: string,
  delimiter: "," | "\t" = ",",
  options: { trimFields?: boolean } = {},
): CsvRecord[] {
  const source = csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const records: CsvRecord[] = [];
  let line = 1;
  let recordLine = 1;
  let fields: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";

  function finishField() {
    fields.push(options.trimFields === false ? field : field.trim());
    field = "";
    state = "unquoted";
  }

  function finishRecord() {
    finishField();
    if (fields.some(Boolean)) records.push({ line: recordLine, fields });
    fields = [];
  }

  for (let offset = 0; offset < source.length; offset++) {
    const character = source[offset];
    if (state === "quoted") {
      if (character === '"') {
        if (source[offset + 1] === '"') {
          field += '"';
          offset++;
        } else {
          state = "closed";
        }
      } else {
        field += character;
        if (character === "\n") line++;
      }
    } else if (character === delimiter) {
      finishField();
    } else if (character === "\n") {
      finishRecord();
      recordLine = ++line;
    } else if (state === "closed") {
      if (character !== " " && character !== "\t") {
        throw new Error(
          `Unexpected text after a closing quote on line ${line}.`,
        );
      }
    } else if (character === '"') {
      if (field.trim()) throw new Error(`Unexpected quote on line ${line}.`);
      field = "";
      state = "quoted";
    } else {
      field += character;
    }
  }

  if (state === "quoted") {
    throw new Error(
      `Unclosed quoted field in the record on line ${recordLine}.`,
    );
  }
  finishRecord();
  return records;
}
