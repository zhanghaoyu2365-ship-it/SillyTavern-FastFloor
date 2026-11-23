import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../visibility.js', import.meta.url), 'utf8');
const { markGenerated, visibilityTargets, applyVisibility } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function fixture() {
    const chat = [
        { mes: '用户消息', is_user: true },
        { mes: '正常回复', is_user: false },
        { mes: '短回复', is_user: false, extra: { model: 'model-a' } },
        { mes: '', is_user: false, extra: { reasoning: '思' } },
        { mes: '系统或已手动隐藏', is_system: true },
        { mes: '旧版回复', is_user: false },
    ];
    markGenerated(chat[2]);
    markGenerated(chat[3]);
    let ctx = { chat, chatId: 'a', characterId: 0, groupId: null };
    const calls = [];
    const saves = [];
    const host = {
        context: () => ctx,
        syncSwipe() {},
        async hideRange(start, end, unhide) {
            calls.push([start, end, unhide]);
            for (let id = start; id <= end; id++) chat[id].is_system = !unhide;
            saves.push(JSON.parse(JSON.stringify(chat)));
        },
    };
    return { chat, host, calls, saves, switchChat: () => { ctx = { ...ctx, chat: [], chatId: 'b' }; } };
}

test('default bulk selection hides only tagged generated floors, including reasoning-only messages', async () => {
    const f = fixture();
    const targets = visibilityTargets(f.chat);
    assert.deepEqual(targets.map(t => t.index), [2, 3]);
    assert.equal(await applyVisibility(f.host, targets, true), 2);
    assert.deepEqual(f.calls, [[2, 3, false]]);
    assert.equal(f.chat[0].is_system, undefined);
    assert.equal(f.chat[1].is_system, undefined);
    assert.equal(f.chat[2].extra.model, 'model-a');
    assert.equal(f.chat[3].extra.reasoning, '思');
    assert.equal(f.saves[0][2].extra.fastFloor.hiddenByPlugin, true);
});

test('inclusive ranges hide old AI messages while skipping users and existing hidden messages', async () => {
    const f = fixture();
    const targets = visibilityTargets(f.chat, { scope: 'range', start: '0', end: '5' });
    assert.deepEqual(targets.map(t => t.index), [1, 2, 3, 5]);
    await applyVisibility(f.host, targets, true);
    assert.deepEqual(f.calls, [[1, 3, false], [5, 5, false]]);
    assert.equal(f.chat[4].extra, undefined);
});

test('restoration survives reloading and leaves manually hidden messages untouched', async () => {
    const f = fixture();
    await applyVisibility(f.host, visibilityTargets(f.chat), true);
    const loadedChat = JSON.parse(JSON.stringify(f.saves[0]));
    assert.deepEqual(visibilityTargets(loadedChat, { hidden: false }).map(t => t.index), [2, 3]);
    await applyVisibility(f.host, visibilityTargets(f.chat, { hidden: false }), false);
    assert.equal(f.chat[2].is_system, false);
    assert.equal(f.chat[2].extra.fastFloor.hiddenByPlugin, false);
    assert.equal(f.chat[4].is_system, true);
    assert.equal(visibilityTargets(f.chat, { hidden: false }).length, 0);
});

test('invalid and blank ranges do not mutate any messages', () => {
    const f = fixture();
    const before = JSON.stringify(f.chat);
    for (const [start, end] of [['', '2'], ['0', ''], ['x', '2'], ['-1', '2'], ['1.5', '3'], ['3', '2'], ['0', '999']]) {
        assert.throws(() => visibilityTargets(f.chat, { scope: 'range', start, end }));
    }
    assert.equal(JSON.stringify(f.chat), before);
});

test('stale message indexes are rejected before mutations', async () => {
    const f = fixture();
    const targets = visibilityTargets(f.chat);
    f.chat.splice(1, 1);
    await assert.rejects(applyVisibility(f.host, targets, true), /聊天内容已变化/);
    assert.equal(f.calls.length, 0);
});

test('switching chats between disjoint ranges stops further writes', async () => {
    const f = fixture();
    const nativeHide = f.host.hideRange;
    f.host.hideRange = async (...args) => { await nativeHide(...args); f.switchChat(); };
    const targets = visibilityTargets(f.chat, { scope: 'range', start: 0, end: 5 });
    await assert.rejects(applyVisibility(f.host, targets, true), /聊天已切换/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.chat[5].is_system, undefined);
});
