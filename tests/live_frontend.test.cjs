const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this[name] = value; }
    getAttribute(name) { return this[name]; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, callback) { this.events[name] = callback; }
}

async function setup() {
    let extension, complete = false;
    let next = 0;
    const timers = new Map(), requests = [];
    const graph = {
        1: { class_type: "Loader", inputs: {} },
        5: { class_type: "QuestionableLiveLoRATuner", inputs: { model: ["1", 0], block_strengths: "{}", action: "preview" } },
        9: { class_type: "SaveImage", inputs: { images: ["5", 1] } },
    };
    const context = {
        app: { registerExtension(value) { extension = value; }, async graphToPrompt() { return { output: graph }; } },
        api: { clientId: "test", apiURL: value => value, async fetchApi(url, options) {
            if (options) {
                const body = JSON.parse(options.body);
                requests.push({ url, body });
                return { ok: true, json: async () => ({ prompt_id: "job" }) };
            }
            return { ok: true, json: async () => complete ? { job: { status: { status_str: "success" }, outputs: {
                5: { images: [{ filename: "test.png", subfolder: "", type: "temp" }],
                    live_lora: [{ blocks: ["blocks.0"], action: "preview", lora: "test.safetensors" }] },
            } } } : {} };
        } },
        document: { createElement: tag => new Element(tag) }, URLSearchParams, structuredClone,
        setTimeout(callback) { timers.set(++next, callback); return next; }, clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/live_lora.js"), "utf8").replace(/^import .*;\r?\n/gm, ""), context);
    class Node {
        constructor() {
            this.id = 5;
            this.widgets = [{ name: "block_strengths", value: "{}" }, { name: "action", value: "preview" },
                { name: "lora_name", value: "test.safetensors" }];
        }
        addDOMWidget(name, type, panel) { this.panel = panel; }
        setDirtyCanvas() { graph[5].inputs.block_strengths = this.widgets[0].value; }
        setSize() {}
    }
    await extension.beforeRegisterNodeDef(Node, { name: "QuestionableLiveLoRATuner" });
    const node = new Node();
    node.onNodeCreated();
    async function tick() {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        await callback();
        await new Promise(setImmediate);
    }
    return { node, graph, timers, requests, tick, done() { complete = true; } };
}

test("live preview queues only the tuner branch, coalesces edits, and stops scheduling", async () => {
    const ui = await setup();
    const actions = ui.node.panel.children[0].children;
    actions[0].events.click();
    await ui.tick();
    assert.deepEqual(Object.keys(ui.requests[0].body.prompt), ["1", "5"]);
    assert.deepEqual(ui.requests[0].body.partial_execution_targets, ["5"]);
    assert.equal(ui.graph[5].inputs.action, "preview");
    ui.done();
    await ui.tick();
    const range = ui.node.panel.children[3].children[0].children[1];
    for (const value of [0.5, 0.7, 0.9]) { range.value = value; range.events.input(); }
    assert.equal(ui.timers.size, 1);
    await ui.tick();
    assert.equal(ui.requests.length, 2);
    assert.equal(JSON.parse(ui.requests[1].body.prompt[5].inputs.block_strengths)["blocks.0"], 0.9);
    actions[0].events.click();
    const nextRange = ui.node.panel.children[3].children[0].children[1];
    nextRange.value = 1.5;
    nextRange.events.input();
    assert.equal(ui.timers.size, 0);
    actions[1].events.click();
    await ui.tick();
    assert.equal(ui.requests.at(-1).body.prompt[5].inputs.action, "verify");
    assert.equal(ui.graph[5].inputs.action, "preview");
});

test("rapid changes during an active preview create only one follow-up job", async () => {
    const ui = await setup();
    const actions = ui.node.panel.children[0].children;
    actions[0].events.click();
    await ui.tick();
    actions[4].events.click();
    actions[4].events.click();
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.timers.size, 1);
    ui.done();
    await ui.tick();
    assert.equal(ui.timers.size, 1);
    await ui.tick();
    assert.equal(ui.requests.length, 2);
    ui.node.onRemoved();
    assert.equal(ui.timers.size, 0);
});
