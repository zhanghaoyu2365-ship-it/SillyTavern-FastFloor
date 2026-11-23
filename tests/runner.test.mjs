import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code = await readFile(new URL('../runner.js', import.meta.url), 'utf8');
const { createFloorRunner, getStreamText, hasSavedText } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

function fixture(custom = {}) {
    const events = new Map();
    let ctx = { chat: [], chatId: 'chat-a', characterId: 0, groupId: null };
    const state = { calls: 0, stops: 0, saved: 0, statuses: [], active: false };
    const emit = (name, ...args) => { for (const f of events.get(name) ?? []) f(...args); };
    const host = {
        context: () => ctx,
        checkReady() {},
        status: (...args) => state.statuses.push(args),
        running: value => { state.active = value; },
        stopGeneration() { state.stops++; emit('GENERATION_STOPPED'); },
        streamText: (text, stream, message) => getStreamText(text, stream, message, { auto_parse: true, prefix: '<think>', suffix: '</think>' }),
        on(name, handler) {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name).add(handler);
            return () => events.get(name).delete(handler);
        },
        async generate() {
            assert.equal(state.saved, state.calls, 'must await prior floor save');
            state.calls++;
            const index = ctx.chat.length;
            ctx.chat.push({ mes: '', is_user: false });
            ctx.streamingProcessor = { messageId: index, type: 'normal' };
            emit('STREAM_TOKEN_RECEIVED', '');
            emit('STREAM_TOKEN_RECEIVED', '   ');
            emit('STREAM_TOKEN_RECEIVED', '<thi');
            emit('STREAM_TOKEN_RECEIVED', '<think>');
            assert.equal(state.stops, state.calls - 1);
            emit('STREAM_TOKEN_RECEIVED', '你');
            assert.equal(state.stops, state.calls, 'stop on first body chunk before Generate resolves');
            emit('STREAM_TOKEN_RECEIVED', '你');
            await Promise.resolve();
            ctx.chat[index].mes = '你';
            state.saved++;
        },
        yield: async () => {},
    };
    Object.assign(host, custom);
    const runner = createFloorRunner(host);
    return { host, runner, state, emit, get ctx() { return ctx; }, setContext: value => { ctx = value; }, events };
}

test('cuts first body chunk, preserves one partial floor, awaits saving, and cleans listeners', async () => {
    const f = fixture();
    const result = await f.runner.start({ floors: 3, prompt: '继续' });
    assert.deepEqual(result, { current: 3, target: 3, cancelled: false });
    assert.equal(f.state.calls, 3);
    assert.equal(f.state.stops, 3);
    assert.deepEqual(f.ctx.chat.map(m => m.mes), ['你', '你', '你']);
    assert.equal(f.state.active, false);
    assert.ok([...f.events.values()].every(set => set.size === 0));
});

test('manual plugin stop interrupts pending request and never restarts', async () => {
    const f = fixture();
    f.host.generate = async () => { f.state.calls++; f.runner.stop(); };
    const result = await f.runner.start({ floors: 20, prompt: '继续' });
    assert.equal(result.cancelled, true);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.stops, 1);
    assert.equal(result.current, 0);
});

test('native stop button cancels batch', async () => {
    const f = fixture();
    f.host.generate = async () => { f.state.calls++; f.emit('GENERATION_STOPPED'); };
    const result = await f.runner.start({ floors: 20, prompt: '继续' });
    assert.equal(result.cancelled, true);
    assert.equal(f.state.calls, 1);
});

test('changing chats stops batch without stopping an unrelated new stream', async () => {
    const f = fixture();
    f.host.generate = async () => {
        f.state.calls++;
        f.setContext({ ...f.ctx, chat: [], chatId: 'chat-b', streamingProcessor: {} });
        f.emit('CHAT_CHANGED');
    };
    const result = await f.runner.start({ floors: 20, prompt: '继续' });
    assert.equal(result.cancelled, true);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.stops, 0);
});

test('API failures stop and restore state instead of retrying', async () => {
    const f = fixture();
    f.host.generate = async () => { f.state.calls++; throw new Error('429'); };
    await assert.rejects(f.runner.start({ floors: 20, prompt: '继续' }), /429/);
    assert.equal(f.state.calls, 1);
    assert.equal(f.runner.running, false);
    assert.ok([...f.events.values()].every(set => set.size === 0));
});

test('silent failure or nonstream response does not count or repeat', async () => {
    const f = fixture();
    f.host.generate = async () => { f.state.calls++; };
    await assert.rejects(f.runner.start({ floors: 20, prompt: '继续' }), /正文或思考/);
    assert.equal(f.state.calls, 1);
});

test('empty saved reply after a cut is not counted', async () => {
    const f = fixture();
    f.host.generate = async () => {
        f.ctx.chat.push({ mes: '', is_user: false });
        f.ctx.streamingProcessor = { messageId: 0, type: 'normal' };
        f.emit('STREAM_TOKEN_RECEIVED', '你');
    };
    await assert.rejects(f.runner.start({ floors: 2, prompt: '继续' }), /有效 AI 回复/);
});

test('double start cannot create concurrent generations', async () => {
    const f = fixture();
    const normalGenerate = f.host.generate;
    f.host.generate = async () => {
        assert.equal(await f.runner.start({ floors: 10, prompt: '继续' }), undefined);
        await normalGenerate();
    };
    await f.runner.start({ floors: 1, prompt: '继续' });
    assert.equal(f.state.calls, 1);
});

test('busy/offline/nonstream prerequisites fail before state or requests change', async () => {
    const f = fixture({ checkReady() { throw new Error('not ready'); } });
    await assert.rejects(f.runner.start({ floors: 1, prompt: '继续' }), /not ready/);
    assert.equal(f.runner.running, false);
    assert.equal(f.state.calls, 0);
});

test('stop between floors prevents the next generation', async () => {
    const f = fixture();
    f.host.yield = async () => f.runner.stop();
    const result = await f.runner.start({ floors: 10, prompt: '继续' });
    assert.equal(result.current, 1);
    assert.equal(result.cancelled, true);
    assert.equal(f.state.calls, 1);
});

test('counts in-band reasoning text but not empty or partial markup', () => {
    const config = { auto_parse: true, prefix: '<think>', suffix: '</think>' };
    const text = value => getStreamText(value, null, null, config);
    assert.equal(text('<t'), '');
    assert.equal(text('<think>'), '');
    assert.equal(text('<think>abc'), 'abc');
    assert.equal(text('<think>abc</think>正文'), 'abc正文');
    assert.equal(text('你好'), '你好');
});

test('reasoning-only streams stop on first reasoning chunk and continue after saving', async () => {
    const f = fixture();
    f.host.generate = async () => {
        assert.equal(f.state.saved, f.state.calls, 'previous save must settle first');
        f.state.calls++;
        const message = { mes: '', is_user: false, extra: { reasoning: '' } };
        const id = f.ctx.chat.push(message) - 1;
        const stream = { type: 'normal', messageId: id, reasoningHandler: { reasoning: '' } };
        f.ctx.streamingProcessor = stream;
        f.emit('STREAM_TOKEN_RECEIVED', '');
        assert.equal(f.state.stops, f.state.calls - 1);
        // Matches native order: handler state changes, text event fires, then save.
        stream.reasoningHandler.reasoning = 'Let';
        f.emit('STREAM_TOKEN_RECEIVED', '');
        assert.equal(f.state.stops, f.state.calls, 'empty text event still interrupts reasoning');
        assert.equal(message.extra.reasoning, '', 'message has not been persisted at interruption');
        await Promise.resolve();
        message.extra.reasoning = stream.reasoningHandler.reasoning;
        f.state.saved++;
    };
    const result = await f.runner.start({ floors: 3, prompt: '继续' });
    assert.deepEqual(result, { current: 3, target: 3, cancelled: false });
    assert.equal(f.state.stops, 3);
    assert.ok(f.ctx.chat.every(m => m.mes === '' && m.extra.reasoning === 'Let'));
});

test('reasoning already persisted on the current message is also detected', () => {
    assert.equal(getStreamText('', {}, { extra: { reasoning: '思' } }), '思');
    assert.equal(getStreamText('', { reasoningHandler: { reasoning: ' ' } }, { extra: { reasoning: '' } }).trim(), '');
});

test('only nonempty body or reasoning validates a saved floor', () => {
    assert.equal(hasSavedText({ mes: '', extra: { reasoning: '思' } }), true);
    assert.equal(hasSavedText({ mes: '你', extra: {} }), true);
    assert.equal(hasSavedText({ mes: '', extra: { reasoning: '  ', reasoning_duration: 4000 } }), false);
    assert.equal(hasSavedText({ mes: '', extra: {} }), false);
});

test('in-band reasoning is kept even when the final saved body is empty', async () => {
    const f = fixture();
    f.host.generate = async () => {
        const message = { mes: '', is_user: false, extra: {} };
        const id = f.ctx.chat.push(message) - 1;
        f.ctx.streamingProcessor = { type: 'normal', messageId: id };
        f.emit('STREAM_TOKEN_RECEIVED', '<think>思');
        assert.equal(f.state.stops, 1);
        message.extra.reasoning = '思';
    };
    const result = await f.runner.start({ floors: 1, prompt: '继续' });
    assert.equal(result.current, 1);
});
