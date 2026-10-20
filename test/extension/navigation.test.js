const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the production class without starting the extension UI or its timers.
const source = fs.readFileSync(path.join(__dirname, '../../source/extension/vt.js'), 'utf8');
const classSource = source.slice(source.indexOf('    class VideoTogetherExtension {'),
    source.indexOf('\n    try {\n        if (window.location.hostname ==', source.indexOf('    class VideoTogetherExtension {')));
const A = 'https://video.example/watch?v=a';
const B = 'https://video.example/watch?v=b';
const C = 'https://video.example/watch?v=c';
const types = { SetTabStorage: 18, SetTabStorageSuccess: 19, JumpToNewPage: 6 };

function member({ page = A, tab = true, autoShare = true, state, session = new Map(), disableRedirect = false } = {}) {
    const messages = [], shares = [], jumps = [];
    let location = new URL(page), id = 0;
    const panel = {
        inputRoomName: {}, inputRoomPassword: {}, setTextMessageHistory() {}, InRoom() {},
        videoTogetherRoleText: {}, textMessageHistory: [],
    };
    const window = {
        sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, String(value)) },
        VideoTogetherStorage: { VideoTogetherTabStorageEnabled: tab, VideoTogetherTabStorage: state,
            DisableRedirectJoin: disableRedirect },
        videoTogetherFlyPannel: panel,
    };
    Object.defineProperty(window, 'location', {
        get: () => location,
        set: value => { jumps.push(String(value)); location = new URL(value); },
    });
    const context = vm.createContext({
        URL, Date, console, window, MessageType: types, inDownload: false,
        Voice: { status: 0 }, VoiceStatus: { STOP: 0, CONNECTTING: 1 },
        isEmpty: value => value == null || value === '', emptyStrIfUdf: value => value ?? '',
        generateUUID: () => `navigation-${++id}`, updateInnnerHTML() {},
        getEnableAutoShareOnNavigate: () => autoShare, isEasyShareMember: () => false, isWeb: () => false,
        sendMessageToTop: (type, data) => messages.push({ type, data }),
        WS: { sendTextMessage: async (id, message) => shares.push(message) },
        setInterval() { throw new Error('Navigation must not create polling timers'); },
    });
    const Extension = vm.runInContext(`${classSource}\nVideoTogetherExtension`, context);
    const extension = Object.assign(Object.create(Extension.prototype), {
        RoleEnum: { Null: 1, Master: 2, Member: 3 }, role: 3,
        url: A, memberPageUrl: A, pendingMemberNavigation: null, memberRoomRequestId: 0,
        roomName: 'room', password: 'password', timeOffset: 0,
    });
    if (state) extension.RecoveryState();
    const writes = () => messages.filter(message => message.type === types.SetTabStorage);
    const jumpMessages = () => messages.filter(message => message.type === types.JumpToNewPage);
    const ack = data => extension.processReceivedMessage(types.SetTabStorageSuccess, data);
    return { extension, window, context, messages, shares, jumps, session, writes, jumpMessages, ack,
        navigate: url => { location = new URL(url); } };
}

test('host switch shares nothing, waits for matching save, and dispatches one jump across repeated polls/acks', async () => {
    const m = member();
    await m.extension.syncMemberNavigation(B);
    const saved = m.writes().at(-1).data;
    assert.equal(saved.VideoTogetherUrl, B);
    assert.equal(m.jumpMessages().length, 0);
    await m.ack({ ...saved, VideoTogetherNavigationId: 'unrelated-history-save' });
    assert.equal(m.jumpMessages().length, 0);
    await m.ack(saved);
    for (let i = 0; i < 20; i++) {
        await m.extension.syncMemberNavigation(B);
        await m.ack(saved);
    }
    assert.equal(m.jumpMessages().length, 1);
    assert.equal(m.writes().length, 1);
    assert.deepEqual(m.shares, []);
});

test('normal polls and chat history retain the room URL; reload does not navigate again', async () => {
    const m = member();
    await m.extension.syncMemberNavigation(B);
    const next = member({ page: B, state: m.writes().at(-1).data });
    for (let i = 0; i < 20; i++) await next.extension.syncMemberNavigation(B);
    next.extension.persistTextMessageHistory(['hello']);
    assert.ok(next.writes().every(write => write.data.VideoTogetherUrl === B));
    const reload = member({ page: B, state: next.writes().at(-1).data });
    await reload.extension.syncMemberNavigation(B);
    assert.equal(reload.jumpMessages().length, 0);
    assert.equal(reload.extension.pendingMemberNavigation, null);
    assert.deepEqual([...m.shares, ...next.shares, ...reload.shares], []);
});

test('site redirect after host navigation is accepted instead of creating a reload loop', async () => {
    const m = member();
    await m.extension.syncMemberNavigation(B);
    const next = member({ page: `${B}&site_redirect=1`, state: m.writes().at(-1).data });
    for (let i = 0; i < 20; i++) await next.extension.syncMemberNavigation(B);
    assert.equal(next.jumpMessages().length, 0);
    assert.deepEqual(next.shares, []);
    assert.equal(next.extension.memberPageUrl, `${B}&site_redirect=1`);
});

test('member navigation shares once for SPA and restored full-page navigation', async () => {
    for (const fullPage of [false, true]) {
        let m = member();
        await m.extension.syncMemberNavigation(A);
        if (fullPage) m = member({ page: C, state: m.writes().at(-1).data });
        else m.navigate(C);
        await m.extension.syncMemberNavigation(A);
        await m.extension.syncMemberNavigation(A);
        assert.deepEqual(m.shares, [`/share ${C}`]);
        await m.ack(m.writes().at(-1).data);
        assert.equal(m.jumpMessages().length, 1);
    }
});

test('initial join and simultaneous host/member changes do not share the previous page', async () => {
    const join = member({ page: C });
    join.extension.url = '';
    join.extension.memberPageUrl = '';
    await join.extension.syncMemberNavigation(A);
    assert.deepEqual(join.shares, []);
    const both = member();
    both.navigate(C);
    await both.extension.syncMemberNavigation(B);
    assert.deepEqual(both.shares, []);
});

test('new host target supersedes old save acknowledgement and leaving cancels pending navigation', async () => {
    const m = member();
    await m.extension.syncMemberNavigation(B);
    const old = m.writes().at(-1).data;
    await m.extension.syncMemberNavigation(C);
    await m.ack(old);
    assert.equal(m.jumpMessages().length, 0);
    const latest = m.writes().at(-1).data;
    m.extension.setRole(1);
    await m.ack(latest);
    assert.equal(m.jumpMessages().length, 0);
});

test('hash-only host switch updates location and finishes in the same document', async () => {
    const m = member({ page: `${A}#one` });
    m.extension.url = `${A}#one`;
    m.extension.memberPageUrl = `${A}#one`;
    await m.extension.syncMemberNavigation(`${A}#two`);
    await m.ack(m.writes().at(-1).data);
    await m.extension.processReceivedMessage(types.JumpToNewPage, m.jumpMessages().at(-1).data);
    await m.extension.syncMemberNavigation(`${A}#two`);
    assert.equal(m.window.location.hash, '#two');
    assert.equal(m.extension.pendingMemberNavigation, null);
    assert.equal(m.jumpMessages().length, 1);
    assert.deepEqual(m.shares, []);
});

test('a queued jump from an older transition cannot override the latest host target', async () => {
    const m = member();
    await m.extension.syncMemberNavigation(B);
    await m.ack(m.writes().at(-1).data);
    const oldJump = m.jumpMessages().at(-1).data;
    await m.extension.syncMemberNavigation(C);
    await m.extension.processReceivedMessage(types.JumpToNewPage, oldJump);
    assert.deepEqual(m.jumps, []);
    await m.ack(m.writes().at(-1).data);
    await m.extension.processReceivedMessage(types.JumpToNewPage, m.jumpMessages().at(-1).data);
    assert.deepEqual(m.jumps, [C]);
});

test('out-of-order scheduled room responses cannot restore an older video', async () => {
    const m = member();
    Object.assign(m.extension, {
        isMain: false, videoMap: new Map(), ForEachVideo: async () => {},
        GetVideoDom: () => undefined, PlayAdNow: () => false,
        UpdateStatusText: () => {}, isIos: false, minTrip: 0, httpSucc: true,
    });
    Object.assign(m.context, {
        getEnableTextMessage: () => true,
        windowPannel: { setTxtMsgInterface() {} },
    });
    Object.assign(m.context.WS, { connect() {}, isOpen: () => true });
    const responses = [];
    m.extension.GetRoom = () => new Promise(resolve => responses.push(resolve));
    const older = m.extension.ScheduledTask();
    const newer = m.extension.ScheduledTask();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses.length, 2);
    responses[1]({ url: C });
    await newer;
    responses[0]({ url: B });
    await older;
    assert.equal(m.extension.url, C);
    assert.equal(m.writes().length, 1);
});

test('session-only same-origin and URL-carried cross-origin state recover without repeated jumps', async () => {
    for (const target of [B, 'https://other.example/video']) {
        const m = member({ tab: false });
        await m.extension.syncMemberNavigation(target);
        const jump = m.jumpMessages().at(-1).data.url;
        const next = member({ tab: false, page: jump, session: m.session });
        next.extension.RecoveryState();
        await next.extension.syncMemberNavigation(target);
        assert.equal(next.extension.url, target);
        assert.equal(next.jumpMessages().length, 0);
        assert.deepEqual([...m.shares, ...next.shares], []);
    }
});

test('disabled auto-share still follows host; disabled redirect shares only member changes', async () => {
    const off = member({ autoShare: false });
    off.navigate(C);
    await off.extension.syncMemberNavigation(A);
    assert.deepEqual(off.shares, []);
    assert.ok(off.extension.pendingMemberNavigation);
    const stay = member({ disableRedirect: true });
    await stay.extension.syncMemberNavigation(B);
    assert.deepEqual(stay.shares, []);
    stay.navigate(C);
    await stay.extension.syncMemberNavigation(B);
    await stay.extension.syncMemberNavigation(B);
    assert.deepEqual(stay.shares, [`/share ${C}`]);
    assert.equal(stay.jumpMessages().length, 0);
});

test('history acknowledgement cannot interrupt an unfinished auto-share', async () => {
    const m = member();
    let finishShare;
    m.context.WS.sendTextMessage = () => new Promise(resolve => { finishShare = resolve; });
    m.navigate(C);
    const sync = m.extension.syncMemberNavigation(A);
    m.extension.persistTextMessageHistory(['incoming message']);
    await m.ack(m.writes().at(-1).data);
    assert.equal(m.jumpMessages().length, 0);
    finishShare();
    await sync;
    await m.ack(m.writes().at(-1).data);
    assert.equal(m.jumpMessages().length, 1);
});

test('tab state bridge serializes asynchronous saves and acknowledges only completed writes', async () => {
    const bridge = fs.readFileSync(path.join(__dirname, '../../source/extension/extension.js'), 'utf8');
    const start = bridge.indexOf('    let tabStorageWrites =');
    const end = bridge.indexOf('\n    if (window.VideoTogetherLoading)', start);
    const saved = [], acknowledged = [], releases = [];
    const context = vm.createContext({
        getGM: () => ({
            getTab: async () => ({}),
            saveTab: tab => new Promise(resolve => releases.push(() => { saved.push(tab.VideoTogetherTabStorage); resolve(); })),
        }),
        window: { postMessage: message => acknowledged.push(message.data) },
    });
    const save = vm.runInContext(`${bridge.slice(start, end)}\nSetTabStorage`, context);
    const first = save({ VideoTogetherUrl: A });
    const second = save({ VideoTogetherUrl: B });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 1);
    assert.equal(acknowledged.length, 0);
    releases.shift()();
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.length, 1);
    releases.shift()();
    await second;
    assert.deepEqual(saved.map(state => state.VideoTogetherUrl), [A, B]);
    assert.deepEqual(acknowledged.map(state => state.VideoTogetherUrl), [A, B]);
});
