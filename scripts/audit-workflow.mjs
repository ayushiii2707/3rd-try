import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');

assert.equal((source.match(/>Check and add<\/button>/g) || []).length, 2, 'Both provider forms must use the exact Check and add label');
assert(!source.includes('＋ Check'), 'The provider action must not have a decorative leading plus');
assert(source.includes('>Select an option</option>'), 'Products must use the requested placeholder');
assert(source.includes("services=['Web','Mobile','API','Database','Service']"), 'Products must expose Web, Mobile, API, Database, and Service exactly once');
assert(source.includes("function dashboardSidebar(active='Home')"), 'The project dashboard must use the reduced project sidebar');
assert(source.includes('onclick="goHome()"'), 'The reduced sidebar Home action must use connection-aware routing');
assert(source.includes("function goHome(){if(!state.connection)"), 'Home must return unverified projects to the initial starting dashboard');
assert(source.includes("onboarding_stage:'choice'"), 'Home must persist the initial dashboard state for unverified projects');
assert(source.includes('function toggleSidebar()'), 'The project sidebar must expose a collapse control');
assert(source.includes("localStorage.setItem('adis-sidebar-collapsed'"), 'The sidebar collapse preference must persist across navigation');
assert(source.includes('project-sidebar.collapsed'), 'Collapsed sidebar styling must be present');
assert(source.includes("onclick=\"showWorkspace()\">↔ SWITCH PROJECT"), 'Switch Project must open the workspace project list');
assert(!source.includes('<h3 style="margin-top:18px">I have requirements</h3>'), 'The requirements-only starting card must remain removed');
assert(!source.includes('<h3 style="margin-top:18px">I have requirements and code</h3>'), 'The combined starting card must remain removed');
assert(source.includes("crypto.subtle.encrypt({name:'AES-GCM'"), 'Credentials must use authenticated AES-GCM encryption');
assert(source.includes('crypto.getRandomValues(new Uint8Array(12))'), 'Every encrypted credential must use a fresh nonce');
assert(source.includes("if(!env.CREDENTIAL_ENCRYPTION_KEY)throw Error('key missing')"), 'The server must fail safely when the encryption key is absent');
assert(source.includes("provider:'github'"), 'GitHub adapter is required');
assert(source.includes("provider:'bitbucket'"), 'Bitbucket adapter is required');
assert(source.includes("https://api.github.com"), 'GitHub must use the official API');
assert(source.includes("https://api.bitbucket.org/2.0"), 'Bitbucket must use the official API');
const safeConnection = source.match(/function safeConnection\(row\)\{([^}]]+)\}/)?.[1] || '';
assert(!safeConnection.includes('encrypted_pat') && !safeConnection.includes('credential_iv'), 'Safe connection responses must not expose stored credentials');

console.log('Workflow audit passed: navigation, sidebar collapse, UI labels/options, provider adapters, and credential safeguards are present.');
