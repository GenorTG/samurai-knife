import { convertCsv, type CsvConvertTasks } from "./csv-convert";
import { serveTasks } from "./workers/runtime";

serveTasks<CsvConvertTasks>({ convert: (input) => convertCsv(input) });
