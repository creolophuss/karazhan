import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { digest, makePackage, sha } from '../../../scripts/scaffold-package.mjs';
import { discover, workspaceBindings } from '../../../scripts/scaffold-discovery.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const command = join(repository, 'scripts/update-scaffolds.mjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const put = (path, text) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, text); };
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => put(path, JSON.stringify(value, null, 2));
const run = (...args) => spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', cwd: repository });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'karazhan-scaffolds-'));
  // macOS tmpdir can use a symlink ancestor; manifests use canonical paths.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function workspace(root, number) {
  mkdirSync(root, { recursive: true });
  const canonical = spawnSync('/bin/pwd', ['-P'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  put(join(root, '.workbench/task.yaml'), `schema_version: 1\nwork:\n  id: "${id(number)}"\n  kind: "task"\nworkspace:\n  path: "${canonical}"\nrepositories: []\n`);
  put(join(root, 'context/requirements.md'), 'Requirement r1: preserve the production safety rule.\n');
  put(join(root, 'context/index.md'), '# Context Index\n');
  put(join(root, 'AGENTS.md'), '# Local instructions\n\nASD-STE100 applies to Chinese.\nBusiness rule: never write production data.\n');
  put(join(root, 'agent_log.md'), 'Historic business log\n');
  put(join(root, '.claude/settings.local.json'), '{"hooks":{"keep":true}}');
  makePackage(repository, join(root, '.agents/skills'));
  put(join(root, '.agents/skills/custom-audit/SKILL.md'), 'User-owned custom Skill.\n');
  return canonical;
}
function review(plan, index = 0) {
  const root = join(plan, 'targets', String(index));
  const path = join(root, 'AGENTS.candidate.md');
  // Stand in for the executing LLM's deliberate merge and review.
  const candidate = `${readFileSync(path, 'utf8')}\nChoose HTML when the content benefits. Build pages directly.\n`;
  put(path, candidate);
  save(join(root, 'review.json'), { reviewed: true, agentsSha256: sha(candidate), notes: 'Reviewed business rule and source changes.' });
}

function skip(plan, index) {
  const path = join(plan, 'TARGETS.md');
  const pattern = new RegExp(`^- \\[ \\](.*<!-- target:${index} -->)$`, 'm');
  const text = readFileSync(path, 'utf8');
  assert.match(text, pattern);
  put(path, text.replace(pattern, '- [x]$1'));
}

test('checked targets are skipped before conflict, review and stale-target checks', t => {
  const root = fixture(t), selected = workspace(join(root, 'project'), 30), excluded = workspace(join(root, 'task'), 31), missing = workspace(join(root, 'missing-task'), 32), plan = join(root, 'preview');
  const manifestPath = join(selected, '.workbench/task.yaml');
  put(manifestPath, readFileSync(manifestPath, 'utf8').replace('kind: "task"', 'kind: "project"'));
  put(join(excluded, '.agents/skills/answer-me-with-html/SKILL.md'), 'Unverified user installation');
  const before = digest(excluded);
  const prepared = run('prepare', '--workspace', selected, '--workspace', excluded, '--workspace', missing, '--out', plan);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(readFileSync(join(plan, 'TARGETS.md'), 'utf8'), /Project/);
  assert.match(readFileSync(join(plan, 'TARGETS.md'), 'utf8'), /Task/);
  assert.ok(load(join(plan, 'plan.json')).targets[1].conflicts.length > 0);
  skip(plan, 1);
  skip(plan, 2);
  rmSync(missing, { recursive: true });
  review(plan, 0);
  const applied = run('apply', '--plan', plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /skipped:/);
  assert.match(readFileSync(join(selected, 'AGENTS.md'), 'utf8'), /Build pages directly/);
  assert.equal(digest(excluded), before);
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(join(plan, 'backups/1')), false);
  assert.equal(existsSync(join(plan, 'backups/2')), false);
  assert.equal(run('apply', '--plan', plan).status, 0);
});

test('all checked targets produce a no-op without target access or backups', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 33), plan = join(root, 'preview');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  skip(plan, 0);
  rmSync(target, { recursive: true });
  const result = run('apply', '--plan', plan);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing changed/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(plan, 'backups')), false);
  assert.equal(existsSync(join(plan, 'applied.json')), false);
});

test('new previews reject missing, incomplete or changed target checklists before writes', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 34), plan = join(root, 'preview');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  review(plan);
  const path = join(plan, 'TARGETS.md'), original = readFileSync(path, 'utf8'), before = digest(target);
  const row = original.split('\n').find(line => line.includes('<!-- target:0 -->'));
  for (const edited of [original.replace('target:0', 'target:999'), `${original}${row}\n`, original.replace(row, ''), original.replace(target, `${target}-different`)]) {
    put(path, edited);
    assert.notEqual(run('apply', '--plan', plan).status, 0);
    assert.equal(digest(target), before);
  }
  rmSync(path);
  assert.notEqual(run('apply', '--plan', plan).status, 0);
  assert.equal(digest(target), before);
});

test('legacy previews without a checklist still use their prepared targets', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 35), plan = join(root, 'preview');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  const manifest = load(join(plan, 'plan.json'));
  delete manifest.selectionFile;
  save(join(plan, 'plan.json'), manifest);
  rmSync(join(plan, 'TARGETS.md'));
  review(plan);
  const result = run('apply', '--plan', plan);
  assert.equal(result.status, 0, result.stderr);
});

test('explicit Workspace prepare/review/apply preserves business data and is repeatable', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 1), plan = join(root, 'preview');
  const preserved = ['.workbench/task.yaml', 'context/requirements.md', 'context/index.md', 'agent_log.md', '.claude/settings.local.json', '.agents/skills/custom-audit'];
  const before = preserved.map(path => digest(join(target, path)));
  const result = run('prepare', '--workspace', target, '--out', plan);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(load(join(plan, 'plan.json')).targets.length, 1);
  assert.deepEqual(load(join(plan, 'plan.json')).targets[0].conflicts, []);
  assert.equal(existsSync(join(target, '.workbench/scaffold-state.json')), false);
  assert.notEqual(run('apply', '--plan', plan).status, 0);
  review(plan);
  const applied = run('apply', '--plan', plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /never write production data/);
  assert.deepEqual(preserved.map(path => digest(join(target, path))), before);
  assert.equal(existsSync(join(plan, 'backups/0/AGENTS.md')), true);
  const repeated = run('apply', '--plan', plan);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /no-op:/);
  const next = join(root, 'next');
  assert.equal(run('prepare', '--workspace', target, '--out', next).status, 0);
  assert.deepEqual(load(join(next, 'plan.json')).targets[0].conflicts, []);
});

test('apply rejects stale targets, changed snapshots, stale reviews and managed symlinks', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 2), plan = join(root, 'preview');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  review(plan);
  const original = readFileSync(join(target, 'context/requirements.md'));
  put(join(target, 'context/requirements.md'), 'changed requirements');
  assert.match(run('apply', '--plan', plan).stderr, /Stale target/);
  put(join(target, 'context/requirements.md'), original);
  const candidate = join(plan, 'targets/0/AGENTS.candidate.md');
  put(candidate, `${readFileSync(candidate, 'utf8')}unreviewed edit`);
  assert.match(run('apply', '--plan', plan).stderr, /review is missing or stale/);
  review(plan);
  put(join(plan, 'source/package/PACKAGE.md'), 'tampered');
  assert.match(run('apply', '--plan', plan).stderr, /Source snapshot changed/);
  const symlinkPlan = join(root, 'symlink-preview');
  rmSync(join(target, '.agents/skills/workspace-provisioning'), { recursive: true });
  symlinkSync(join(repository, 'blueprints/skills/workspace-provisioning'), join(target, '.agents/skills/workspace-provisioning'));
  assert.equal(run('prepare', '--workspace', target, '--out', symlinkPlan).status, 0);
  assert.match(load(join(symlinkPlan, 'plan.json')).targets[0].conflicts.join(' '), /[Ss]ymlink/);
});

test('unknown old packages and duplicate identities require reviewed migration or conflict resolution', t => {
  const root = fixture(t), first = workspace(join(root, 'first'), 3), second = workspace(join(root, 'second'), 3);
  rmSync(join(first, '.agents/skills/PACKAGE.md'));
  const plan = join(root, 'preview');
  assert.equal(run('prepare', '--workspace', first, '--workspace', second, '--out', plan).status, 0);
  const targets = load(join(plan, 'plan.json')).targets;
  assert.equal(targets.length, 2);
  assert.ok(targets.every(target => target.conflicts.some(message => /Duplicate Work ID/.test(message))));
  assert.match(run('apply', '--plan', plan).stderr, /unresolved target conflicts/);
});

test('retirement requires a digest-verified package entry and preserves unrelated Skills', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 20), skills = join(target, '.agents/skills');
  put(join(skills, 'answer-me-with-html/SKILL.md'), 'Old renderer\n');
  const unlisted = join(root, 'unlisted');
  assert.equal(run('prepare', '--workspace', target, '--out', unlisted).status, 0);
  assert.match(load(join(unlisted, 'plan.json')).targets[0].conflicts.join(' '), /answer-me-with-html/);
  assert.equal(existsSync(join(skills, 'answer-me-with-html/SKILL.md')), true);
  const managed = join(root, 'managed-package');
  mkdirSync(managed);
  for (const name of ['workspace-provisioning', 'karazhan-mcp-collaboration', 'answer-me-with-html']) cpSync(join(skills, name), join(managed, name), { recursive: true });
  const summary = `# Old kit\n- Skills digest (SHA-256): ${digest(managed)}\n- Installed Skills: workspace-provisioning, karazhan-mcp-collaboration, answer-me-with-html\n`;
  put(join(skills, 'PACKAGE.md'), summary);
  const plan = join(root, 'verified');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  assert.deepEqual(load(join(plan, 'plan.json')).targets[0].conflicts, []);
  review(plan);
  const applied = run('apply', '--plan', plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(skills, 'answer-me-with-html')), false);
  assert.equal(existsSync(join(skills, 'custom-audit/SKILL.md')), true);
});

test('reviewed managed candidates preserve local Skill changes and reject stale candidates', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 40), plan = join(root, 'preview');
  const path = '.agents/skills/workspace-provisioning';
  put(join(target, path, 'references/local-rule.md'), 'Retain the local business approval boundary.\n');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  review(plan);
  assert.match(run('apply', '--plan', plan).stderr, /unresolved target conflicts/);
  const candidate = join(plan, 'targets/0/managed-candidates', path);
  cpSync(join(repository, 'blueprints/skills/workspace-provisioning'), candidate, { recursive: true });
  put(join(candidate, 'references/local-rule.md'), 'Retain the local business approval boundary.\n');
  const reviewPath = join(plan, 'targets/0/review.json'), reviewed = load(reviewPath);
  reviewed.managed = { [path]: { action: 'replace', beforeSha256: load(join(plan, 'plan.json')).targets[0].before[path], candidateSha256: digest(candidate), notes: 'Merged the current scaffold and retained the local approval boundary.' } };
  const packageRoot = join(root, 'resolved-package');
  cpSync(join(plan, 'source/package'), packageRoot, { recursive: true });
  rmSync(join(packageRoot, 'workspace-provisioning'), { recursive: true });
  cpSync(candidate, join(packageRoot, 'workspace-provisioning'), { recursive: true });
  const packagePath = '.agents/skills/PACKAGE.md', packageCandidate = join(plan, 'targets/0/managed-candidates', packagePath);
  put(packageCandidate, readFileSync(join(packageRoot, 'PACKAGE.md'), 'utf8').replace(/Skills digest \(SHA-256\): [0-9a-f]+/, `Skills digest (SHA-256): ${digest(packageRoot, ['PACKAGE.md'])}`));
  reviewed.managed[packagePath] = { action: 'replace', beforeSha256: load(join(plan, 'plan.json')).targets[0].before[packagePath], candidateSha256: digest(packageCandidate), notes: 'Updated package evidence for the reviewed local Skill variant.' };
  save(reviewPath, reviewed);
  const before = digest(target);
  put(join(candidate, 'unreviewed.txt'), 'Changed after review');
  assert.match(run('apply', '--plan', plan).stderr, /Managed candidate review is missing or stale/);
  assert.equal(digest(target), before);
  rmSync(join(candidate, 'unreviewed.txt'));
  const result = run('apply', '--plan', plan);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(target, path, 'references/local-rule.md'), 'utf8'), 'Retain the local business approval boundary.\n');
  assert.equal(readFileSync(join(plan, 'backups/0', path, 'references/local-rule.md'), 'utf8'), 'Retain the local business approval boundary.\n');
  assert.equal(run('apply', '--plan', plan).status, 0);
});

test('explicit retirement reviews bind the original content and cannot authorize unrelated paths', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 41), plan = join(root, 'preview');
  const retired = '.agents/skills/answer-me-with-html';
  put(join(target, retired, 'SKILL.md'), 'Old renderer reviewed for retirement.\n');
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  review(plan);
  const reviewPath = join(plan, 'targets/0/review.json'), reviewed = load(reviewPath);
  reviewed.managed = { '../outside': { action: 'retire', beforeSha256: 'invalid', notes: 'Not a prepared path' } };
  save(reviewPath, reviewed);
  assert.match(run('apply', '--plan', plan).stderr, /Invalid managed content review/);
  reviewed.managed = { [retired]: { action: 'retire', beforeSha256: 'wrong', notes: 'Reviewed renderer contents; preserve them in the backup.' } };
  save(reviewPath, reviewed);
  assert.match(run('apply', '--plan', plan).stderr, /Invalid managed content review/);
  assert.equal(existsSync(join(target, retired)), true);
  reviewed.managed[retired].beforeSha256 = load(join(plan, 'plan.json')).targets[0].before[retired];
  save(reviewPath, reviewed);
  const result = run('apply', '--plan', plan);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(target, retired)), false);
  assert.equal(readFileSync(join(plan, 'backups/0', retired, 'SKILL.md'), 'utf8'), 'Old renderer reviewed for retirement.\n');
});

test('failed replacement restores original managed files from the private backup', t => {
  const root = fixture(t), target = workspace(join(root, 'work'), 21), plan = join(root, 'preview');
  const before = digest(target);
  assert.equal(run('prepare', '--workspace', target, '--out', plan).status, 0);
  review(plan);
  const injector = join(root, 'fail-rename.mjs');
  put(injector, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.renameSync; let failed=false; fs.renameSync=(a,b)=>{ if(!failed&&b.endsWith('/AGENTS.md')){failed=true;throw new Error('synthetic rename failure');} return original(a,b); };syncBuiltinESMExports();\n`);
  const failed = spawnSync(process.execPath, ['--import', injector, command, 'apply', '--plan', plan], { encoding: 'utf8', cwd: repository });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Restored failed target/);
  assert.equal(digest(target), before);
  assert.equal(existsSync(join(plan, 'backups/0/AGENTS.md')), true);
});

test('explicit Medivh-only updates require no Workspace, binary or build and preserve user data', t => {
  const root = fixture(t), profile = join(root, 'custom-profile'), plan = join(root, 'preview');
  put(join(profile, 'AGENTS.md'), 'ASD-STE100. Preserve user memories.\n');
  cpSync(join(repository, 'blueprints/medivh/SOUL.md'), join(profile, 'SOUL.md'));
  for (const skill of ['workspace-provisioning', 'medivh-karazhan-registration']) cpSync(join(repository, 'blueprints/skills', skill), join(profile, 'skills/karazhan', skill), { recursive: true });
  put(join(profile, 'memories/USER.md'), 'User memory\n');
  put(join(profile, 'sessions/keep'), 'Session state\n');
  const result = run('prepare', '--medivh-profile', profile, '--out', plan);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(load(join(plan, 'plan.json')).targets.length, 1);
  assert.deepEqual(load(join(plan, 'plan.json')).targets[0].conflicts, []);
  review(plan);
  const applied = run('apply', '--plan', plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(join(profile, 'memories/USER.md'), 'utf8'), 'User memory\n');
  assert.equal(readFileSync(join(profile, 'sessions/keep'), 'utf8'), 'Session state\n');
  assert.equal(existsSync(join(profile, 'packages/custodian-startup-kit/.agents/skills/PACKAGE.md')), true);
});

test('default discovery follows only Workspace navigation and known children; warns when Karazhan is unavailable', async t => {
  const root = fixture(t), home = join(root, 'home'), owner = workspace(join(root, 'owner'), 4), child = workspace(join(root, 'external child with spaces'), 5);
  const nested = workspace(join(owner, 'children/unregistered'), 6), legacy = workspace(join(root, 'legacy-workspace'), 7);
  put(join(owner, 'context/index.md'), `## Direct Children\n\n| Work ID | Workspace |\n| --- | --- |\n| ${id(5)} | \`${child}\` |\n| ${id(8)} | \`${join(owner, 'children/missing')}\` |\n\n## Applicable inputs\n\nLegacy evidence: ${legacy}\n`);
  const profile = join(home, 'custom-medivh'); mkdirSync(profile, { recursive: true });
  put(join(home, '.local/share/karazhan-installer/medivh-profile-path'), profile);
  const old = { ...process.env };
  process.env.KARAZHAN_HERMES_COMMAND = '/usr/bin/false';
  for (const key of ['KARAZHAN_DATABASE_PATH', 'KARAZHAN_INSTALL_STATE_DIR', 'KARAZHAN_MEDIVH_PROFILE_DIR', 'KARAZHAN_INSTALL_BIN_DIR']) delete process.env[key];
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  const result = await discover([], [], { home, cwd: owner });
  assert.ok(result.found.some(entry => entry.path === nested));
  assert.ok(result.found.some(entry => entry.path === child && entry.work === id(5)));
  assert.ok(result.found.some(entry => entry.path === join(owner, 'children/missing')));
  assert.equal(result.found.some(entry => entry.path === legacy), false);
  assert.ok(result.warnings.some(message => /Karazhan discovery unavailable/.test(message)));
  assert.deepEqual(result.profiles, [profile]);
  const missingDatabase = join(root, 'missing-database.sqlite3');
  process.env.KARAZHAN_DATABASE_PATH = missingDatabase;
  process.env.KARAZHAN_MCP_COMMAND = '/should-not-be-started';
  const missing = await discover([], [], { home, cwd: owner });
  assert.ok(missing.warnings.some(message => /existing regular file.*MCP was not started/.test(message)));
  assert.equal(existsSync(missingDatabase), false);
});

test('stdio discovery queries Project and Task primary bindings only', async t => {
  const root = fixture(t), server = join(root, 'mock-mcp');
  put(server, `#!${process.execPath}\nimport readline from 'node:readline';\nreadline.createInterface({input:process.stdin}).on('line', line => {\n const m=JSON.parse(line); if (!m.id) return; let result={};\n if(m.method==='tools/call'){if(m.params.name!=='karazhan_query')process.exit(9);const q=m.params.arguments.request;let payload=[];\n if(q.type==='list_projects')payload=[{id:'project'}];\n if(q.type==='list_tasks')payload=[{id:'task'},{id:'unbound-task'}];\n if(q.type==='list_resource_bindings'&&q.node_id!=='unbound-task')payload=[{kind:'workspace',is_primary:true,availability:'missing',locator:'/synthetic/'+q.node_id},{kind:'workspace',is_primary:false,availability:'available',locator:'/synthetic/legacy'}];\n result={content:[{type:'text',text:JSON.stringify({payload})}]};}\n console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));\n});\n`);
  chmodSync(server, 0o755);
  const result = await workspaceBindings(server, join(root, 'explicit-database'));
  assert.deepEqual(result.found.map(entry => entry.path), ['/synthetic/project', '/synthetic/task']);
  assert.ok(result.warnings.some(message => /No Workspace binding for unbound-task/.test(message)));
});
