import { profileCsv, type CsvProfileTasks } from "./csv-profile";
import { serveTasks } from "./workers/runtime";

serveTasks<CsvProfileTasks>({ profile: (input) => profileCsv(input) });
