// CV projects (src/lib/cv/projects.ts, docs/CV-STUDIO.md "Projects"): several separate CVs per account. An account from
// before projects keeps its files as the project `main` (no migration step, no byte moved); every project has its own CV,
// undo snapshots, photo and website; the tools take `projectId`; the routes bind `?project=`.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_projects.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-cv-projects-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const projects = await import("../src/lib/cv/projects.ts");
const { loadCv, mutateCv, saveCv, undoCv } = await import("../src/lib/cv/store.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const { savePhoto, readPhoto } = await import("../src/lib/cv/photo-store.ts");
const { loadSite, mutateSite } = await import("../src/lib/site/store.ts");
const { CV_KNIFE_TOOLS } = await import("../src/lib/mcp/tools-cv.ts");
const { SITE_KNIFE_TOOLS } = await import("../src/lib/mcp/tools-site.ts");
const { cvPaths } = await import("../src/lib/storage/quota.ts");

const named = (name) => ({ ...emptyCvData(), profile: { ...emptyCvData().profile, contact: { ...emptyCvData().profile.contact, name } } });
const nameIn = (account, project) => projects.withCvProject(account, project, () => loadCv(account).profile.contact.name);
const tool = (name) => CV_KNIFE_TOOLS.find((t) => t.name === name) ?? SITE_KNIFE_TOOLS.find((t) => t.name === name);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

test("an account from before projects: its CV is the project `main`, named after the CV, nothing written on read", () => {
  saveCv("legacy", named("Ada Lovelace"));
  const before = readdirSync(join(dataDir, "cv")).sort();
  const list = projects.listProjects("legacy");
  assert.equal(list.active, "main");
  assert.deepEqual(list.projects.map((p) => [p.id, p.name]), [["main", "Ada Lovelace"]]);
  assert.equal(loadCv("legacy").profile.contact.name, "Ada Lovelace");
  assert.deepEqual(readdirSync(join(dataDir, "cv")).sort(), before, "listing projects writes nothing");
  assert.equal(projects.listProjects("brand-new").projects[0].name, "My CV");
});

test("a second project is separate (CV, undo, photo, website) and becomes active; switching follows", () => {
  const id = "multi";
  saveCv(id, named("First Person"));
  savePhoto(id, JPEG);
  mutateSite(id, (s) => {
    s.siteUrl = { url: "https://first.example", pages: [], token: "sk-1", verifiedOrigin: "", setAt: "x" };
  });
  const second = projects.createProject(id, { name: "Second person" });
  assert.match(second.id, /^second-person$/);
  assert.equal(projects.listProjects(id).active, second.id);
  // The active project is now empty: a fresh CV, no photo, no website.
  assert.equal(loadCv(id).profile.contact.name, "");
  assert.equal(readPhoto(id), null);
  assert.equal(loadSite(id).siteUrl, null);
  saveCv(id, named("Second Person"));
  saveCv(id, named("Second Person v2"));
  assert.equal(nameIn(id, "main"), "First Person", "the first project is untouched");
  // Undo works per project.
  assert.ok(undoCv(id));
  assert.equal(loadCv(id).profile.contact.name, "Second Person");
  assert.equal(nameIn(id, "main"), "First Person");
  projects.setActiveProject(id, "main");
  assert.equal(loadCv(id).profile.contact.name, "First Person");
  assert.deepEqual(readPhoto(id), JPEG);
  assert.equal(loadSite(id).siteUrl?.url, "https://first.example");
  // Every project file sits under cv/<account>.* (quota, rename and account deletion cover them) or the account site file.
  const files = cvPaths(id).map((p) => p.split("/").pop());
  assert.ok(files.includes("multi.p-second-person.json") && files.includes("multi.projects.json"), files.join(","));
});

test("duplicate copies the CV and photo, never the website; names stay unique; ids are slugs", () => {
  const id = "dup";
  saveCv(id, named("Source"));
  savePhoto(id, JPEG);
  mutateSite(id, (s) => {
    s.siteUrl = { url: "https://src.example", pages: [], token: "sk-2", verifiedOrigin: "", setAt: "x" };
  });
  const copy = projects.createProject(id, { name: "Source", duplicateOf: "main" });
  const copy2 = projects.createProject(id, { name: "Source", duplicateOf: "main" });
  assert.notEqual(copy.id, copy2.id);
  assert.equal(nameIn(id, copy.id), "Source");
  assert.deepEqual(projects.withCvProject(id, copy.id, () => readPhoto(id)), JPEG);
  assert.equal(projects.withCvProject(id, copy.id, () => loadSite(id).siteUrl), null);
  const weird = projects.createProject(id, { name: "Żółć & main!" });
  assert.match(weird.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.throws(() => projects.createProject(id, { name: "   " }), /name/);
});

test("rename, delete (files gone, active moves), the last project cannot be deleted, unknown ids are 404", () => {
  const id = "del";
  saveCv(id, named("Keep"));
  const other = projects.createProject(id, { name: "Temp" });
  saveCv(id, named("Temp CV"));
  savePhoto(id, JPEG);
  projects.renameProject(id, other.id, "Renamed");
  assert.equal(projects.getProject(id, other.id)?.name, "Renamed");
  const paths = projects.projectPaths(id, other.id);
  assert.ok(existsSync(paths.file) && existsSync(paths.photo));
  assert.deepEqual(projects.deleteProject(id, other.id), { active: "main" });
  assert.ok(!existsSync(paths.file) && !existsSync(paths.photo) && !existsSync(paths.snapshots));
  assert.equal(loadCv(id).profile.contact.name, "Keep");
  assert.throws(() => projects.deleteProject(id, "main"), (e) => e instanceof projects.CvProjectError && e.status === 409);
  assert.throws(() => projects.setActiveProject(id, "nope"), (e) => e.status === 404);
  assert.throws(() => projects.withCvProject(id, "nope", () => 1), (e) => e.status === 404);
  // A new project reusing a deleted id starts empty (no leftovers come back).
  const again = projects.createProject(id, { name: "Temp" });
  assert.equal(loadCv(id).profile.contact.name, "");
  assert.equal(readPhoto(id), null);
  assert.ok(again.id);
});

test("routes: ?project= binds the request, an unknown one is refused before anything runs", () => {
  const id = "routes";
  saveCv(id, named("Main"));
  const p = projects.createProject(id, { name: "Other" });
  projects.setActiveProject(id, "main");
  const ok = projects.bindRequestProject(new Request(`http://x/api/cv?project=${p.id}`), id);
  assert.equal(ok, null);
  assert.equal(projects.currentProjectId(id), p.id, "bound for the rest of this request");
  const refused = projects.bindRequestProject(new Request("http://x/api/cv?project=ghost"), id);
  assert.equal(refused?.status, 404);
});

test("tools: every knife_cv_* and knife_site_* takes projectId; project list/create/switch", async () => {
  const id = "tools";
  const ctx = { accountId: id, admin: true };
  saveCv(id, named("Main person"));
  const created = await tool("knife_cv_project_create").execute({ name: "Anna" }, ctx);
  assert.equal(created.active, created.project.id);
  await tool("knife_cv_patch").execute({ ops: [{ op: "set", path: "/contact/name", value: "Anna Nowak" }] }, ctx);
  // Explicit projectId reads/writes another project without switching.
  const main = await tool("knife_cv_get").execute({ path: "/contact/name", projectId: "main" }, ctx);
  assert.equal(main, "Main person");
  await tool("knife_cv_patch").execute({ ops: [{ op: "set", path: "/contact/name", value: "Main renamed" }], projectId: "main" }, ctx);
  assert.equal(nameIn(id, "main"), "Main renamed");
  assert.equal(projects.listProjects(id).active, created.project.id, "projectId never switches the user's view");
  const list = await tool("knife_cv_project_list").execute({}, ctx);
  assert.deepEqual(list.projects.map((p) => p.owner), ["Main renamed", "Anna Nowak"]);
  await tool("knife_cv_project_switch").execute({ id: "main" }, ctx);
  assert.equal(projects.listProjects(id).active, "main");
  await assert.rejects(tool("knife_cv_get").execute({ projectId: "ghost" }, ctx), /no CV project/);
  for (const t of [...CV_KNIFE_TOOLS, ...SITE_KNIFE_TOOLS]) {
    if (t.name.startsWith("knife_cv_project_")) continue;
    assert.ok("projectId" in t.schema.shape, `${t.name} takes projectId`);
  }
});

test("website: GitHub installations stay account-wide; the connection is per project", () => {
  const id = "site";
  mutateSite(id, (s) => {
    s.github = { login: "octo", installations: [], checkedAt: "x" };
    s.siteUrl = { url: "https://main.example", pages: [], token: "sk-3", verifiedOrigin: "", setAt: "x" };
  });
  const p = projects.createProject(id, { name: "Two" });
  assert.equal(loadSite(id).github?.login, "octo", "the sign-in shows in every project");
  assert.equal(loadSite(id).siteUrl, null);
  mutateSite(id, (s) => {
    s.siteUrl = { url: "https://two.example", pages: [], token: "sk-4", verifiedOrigin: "", setAt: "x" };
    s.github = { login: "octo2", installations: [], checkedAt: "y" };
  });
  projects.setActiveProject(id, "main");
  assert.equal(loadSite(id).siteUrl?.url, "https://main.example");
  assert.equal(loadSite(id).github?.login, "octo2", "a link made in project two is the account's");
  assert.equal(projects.withCvProject(id, p.id, () => loadSite(id).siteUrl?.url), "https://two.example");
});

test("mutateCv inside withCvProject writes that project even while another is active", () => {
  const id = "bound";
  saveCv(id, named("A"));
  const b = projects.createProject(id, { name: "B" });
  projects.setActiveProject(id, "main");
  projects.withCvProject(id, b.id, () => mutateCv(id, (data) => ({ data: { ...data, profile: { ...data.profile, contact: { ...data.profile.contact, name: "B wrote" } } }, result: null })));
  assert.equal(nameIn(id, b.id), "B wrote");
  assert.equal(loadCv(id).profile.contact.name, "A");
});
