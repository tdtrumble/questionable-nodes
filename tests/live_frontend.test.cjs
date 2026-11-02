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
    const timers = new Map(), requests = [], presets = [];
    const graph = {
        1: { class_type: "Loader", inputs: {} },
        5: { class_type: "QuestionableLiveLoRATuner", inputs: { model: ["1", 0], block_strengths: "{}", action: "preview" } },
        9: { class_type: "SaveImage", inputs: { images: ["5", 1] } },
    };
    const context = {
        app: { registerExtension(value) { extension = value; }, async graphToPrompt() { return { output: graph }; } },
        api: { clientId: "test", apiURL: value => value, async fetchApi(url, options) {
            if (url === "/questionable-nodes/tuner/presets") {
                if (options) {
                    const preset = JSON.parse(options.body);
                    presets.push(preset);
                    return { ok: true, json: async () => preset };
                }
                return { ok: true, json: async () => presets };
            }
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
                { name: "lora_name", value: "test.safetensors" }, { name: "strength", value: 1 }];
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
    return { node, graph, timers, requests, tick, presets, context, done() { complete = true; } };
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

test("saved presets restore all adjustments and reject mismatched block layouts", async () => {
    const ui = await setup();
    const info = { blocks: ["blocks.0"], action: "preview", lora: "test.safetensors" };
    ui.node.onExecuted({ live_lora: [info] });
    const controls = ui.node.panel.children[4].children;
    controls[0].value = "portrait";
    ui.node.widgets[0].value = '{"blocks.0":-0.5}';
    ui.node.widgets[3].value = 0.8;
    await controls[3].events.click();
    assert.equal(ui.presets[0].name, "portrait");
    ui.node.widgets[0].value = "{}";
    ui.node.widgets[3].value = 1;
    controls[4].events.click();
    assert.equal(JSON.parse(ui.node.widgets[0].value)["blocks.0"], -0.5);
    assert.equal(ui.node.widgets[3].value, 0.8);
    ui.node.onExecuted({ live_lora: [{ ...info, blocks: ["blocks.1"] }] });
    controls[4].events.click();
    assert.match(ui.node.panel.children[1].textContent, /layout matches/);
});

test("trainer exports preserve exact weights and explicitly select only active mapped layers", async () => {
    const ui = await setup();
    const info = { blocks: ["blocks.0", "blocks.1"], trainer_targets: { family: "krea2",
        native: { "blocks.0": ["blocks.0.attn.wq"], "blocks.1": ["blocks.1.attn.wq"] },
        diffusers: { "blocks.0": ["transformer_blocks.0.attn.to_q"], "blocks.1": ["transformer_blocks.1.attn.to_q"] } } };
    ui.context.info = info;
    const run = format => vm.runInNewContext(`trainerExport(info, {"blocks.0":-0.5, "blocks.1":0}, 0.8, "${format}")`, ui.context);
    assert.equal(JSON.parse(run("exact")).effective_strengths["blocks.0"], -0.4);
    assert.deepEqual(JSON.parse(run("ai_toolkit")).network.network_kwargs.only_if_contains, ["blocks.0.attn.wq"]);
    const one = JSON.parse(run("onetrainer"));
    assert.equal(new RegExp(one.layer_filter).test("transformer_blocks.0.attn.to_q"), true);
    assert.equal(new RegExp(one.layer_filter).test("transformer_blocks.10.attn.to_q"), false);
    assert.match(JSON.parse(run("musubi")).network_args[1], /blocks/);
    assert.throws(() => run("kohya"), /FLUX.1/);
    ui.context.info.trainer_targets.diffusers = {};
    assert.throws(() => run("onetrainer"), /no verified trainer mapping/);
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
