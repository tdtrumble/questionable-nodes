const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    addEventListener(name, callback) { this.events[name] = callback; }
}

async function setup(type, widgets) {
    let extension;
    const requests = [];
    let response;
    const context = {
        app: { registerExtension(value) { extension = value; } },
        api: { apiURL: value => value, async fetchApi(url, options) {
            requests.push({ url, body: JSON.parse(options.body) });
            return { ok: true, json: async () => response };
        } },
        document: { createElement: tag => new Element(tag) }, URLSearchParams,
    };
    const source = fs.readFileSync(path.join(__dirname, "../web/audition.js"), "utf8").replace(/^import .*;\r?\n/gm, "");
    vm.runInNewContext(source, context);
    class Node {
        constructor() { this.widgets = widgets; }
        addDOMWidget(name, type, panel) { this.panel = panel; }
        setDirtyCanvas() {}
        setSize() {}
    }
    await extension.beforeRegisterNodeDef(Node, { name: type });
    const node = new Node();
    node.onNodeCreated();
    return { node, requests, respond(value) { response = value; } };
}

test("prompt editor adds, edits, reorders, removes, and restores multiline prompts", async () => {
    const widget = { name: "prompts", value: '[""]' };
    const { node } = await setup("QuestionableAuditionPromptList", [widget]);
    let row = node.panel.children[0];
    row.children[1].value = "portrait\nindoors";
    row.children[1].events.input();
    node.panel.children.at(-1).events.click();
    row = node.panel.children[1];
    row.children[1].value = "landscape";
    row.children[1].events.input();
    row.children[0].children[0].events.click();
    assert.deepEqual(JSON.parse(widget.value), ["landscape", "portrait\nindoors"]);
    node.onConfigure();
    assert.equal(node.panel.children[1].children[1].value, "portrait\nindoors");
    node.panel.children[0].children[0].children[2].events.click();
    assert.deepEqual(JSON.parse(widget.value), ["portrait\nindoors"]);
});

function session() {
    return { name: "test", cards: [{ id: "run:0:0", run: "run", prompt: "portrait", seed: 42, sample: 1,
        winner: null, candidates: ["a", "b"].map(id => ({ id, name: id, image: { filename: `${id}.png`, type: "output", subfolder: "audition" } })) }],
        rankings: { all: [], "a:b": [] } };
}

test("review slider only browses; explicit choices save once and survive new results", async () => {
    const ui = await setup("QuestionableAuditionReview", [{ name: "session", value: "test" }]);
    const data = session();
    ui.node.onExecuted({ audition_session: [data] });
    const panel = ui.node.panel;
    const cards = panel.children[4];
    let card = cards.children[0];
    const slider = card.children[3];
    slider.value = 1;
    slider.events.input();
    assert.match(card.children[2].src, /b.png/);
    assert.equal(ui.requests.length, 0);
    card.children[6].events.click();
    ui.node.onExecuted({ audition_session: [data] });
    assert.match(cards.children[0].children[5].textContent, /Chosen: b/);
    const saved = session();
    saved.cards[0].winner = "b";
    ui.respond(saved);
    await panel.children[0].children[1].events.click();
    assert.deepEqual(ui.requests[0].body, { name: "test", votes: { "run:0:0": "b" } });
    assert.equal(panel.inert, false);
    card = cards.children[0];
    card.children[7].events.click();
    ui.respond(data);
    await panel.children[0].children[1].events.click();
    assert.deepEqual(ui.requests[1].body.votes, { "run:0:0": null });
});

test("changing review session clears cards and saved session reload restores them", async () => {
    const widget = { name: "session", value: "test" };
    const ui = await setup("QuestionableAuditionReview", [widget]);
    ui.node.onExecuted({ audition_session: [session()] });
    widget.value = "other";
    widget.callback();
    assert.equal(ui.node.panel.children[4].children.length, 0);
    ui.node.onExecuted({ audition_session: [session()] });
    assert.equal(ui.node.panel.children[4].children.length, 0);
    widget.value = "test";
    ui.respond(session());
    await ui.node.panel.children[0].children[0].events.click();
    assert.equal(ui.node.panel.children[4].children.length, 1);
});
