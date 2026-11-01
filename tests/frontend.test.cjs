const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.events = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(name, handler) { this.events[name] = handler; }
}

async function setup() {
    let extension;
    let files = ["a.safetensors", "B.safetensors"];
    let response;
    const context = {
        app: { registerExtension(value) { extension = value; } },
        api: { async fetchApi() { return response ? response : { ok: true, json: async () => ({ files }) }; } },
        document: { createElement: tag => new Element(tag), createTextNode: text => text },
    };
    const source = fs.readFileSync(path.join(__dirname, "../web/lora_audition.js"), "utf8").replace(/^import .*;\r?\n/gm, "");
    vm.runInNewContext(source, context);
    class Node {
        constructor() {
            this.widgets = [
                { name: "directory", value: "C:/loras" },
                { name: "recursive", value: false },
                { name: "selection", value: '{"selected":[]}' },
            ];
            this.size = [200, 100];
        }
        addDOMWidget(name, type, panel, options) { this.panel = panel; assert.equal(options.serialize, false); }
        setDirtyCanvas() {}
        setSize(size) { this.size = size; }
    }
    await extension.beforeRegisterNodeDef(Node, { name: "QuestionableLoRAAudition" });
    const node = new Node();
    node.onNodeCreated();
    const [actions, status, list] = node.panel.children;
    const [scan, selectAll] = actions.children;
    return { node, scan, selectAll, status, list, state: () => JSON.parse(node.widgets[2].value),
        setFiles(value) { files = value; }, setResponse(value) { response = value; } };
}

test("scan defaults unchecked, rescan keeps selections and unchecks new files", async () => {
    const ui = await setup();
    await ui.scan.events.click();
    assert.deepEqual(ui.state().selected, []);
    assert.equal(ui.list.children[0].children[0].checked, false);
    const checkbox = ui.list.children[0].children[0];
    checkbox.checked = true;
    checkbox.events.change();
    ui.setFiles(["a.safetensors", "new.safetensors"]);
    await ui.scan.events.click();
    assert.deepEqual(ui.state().selected, ["a.safetensors"]);
    assert.equal(ui.list.children[1].children[0].checked, false);
    ui.selectAll.events.click();
    assert.deepEqual(ui.state().selected, ["a.safetensors", "new.safetensors"]);
    assert.equal(ui.list.children.every(row => row.children[0].checked), true);
    assert.equal(ui.status.textContent, "2 selected / 2 files");
});

test("saved selection is restored and directory changes clear the list", async () => {
    const ui = await setup();
    const saved = { directory: "C:/loras", recursive: false, files: ["a.safetensors"], selected: ["a.safetensors"] };
    ui.node.widgets[2].value = JSON.stringify(saved);
    ui.node.onConfigure();
    assert.equal(ui.list.children[0].children[0].checked, true);
    ui.node.widgets[0].value = "C:/different";
    ui.node.widgets[0].callback();
    assert.deepEqual(ui.state().selected, []);
    assert.equal(ui.list.children.length, 0);
    assert.equal(ui.selectAll.disabled, true);
});

test("recursive changes clear selections and stale scans cannot restore them", async () => {
    const ui = await setup();
    let finish;
    ui.setResponse({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
    const pending = ui.scan.events.click();
    await new Promise(setImmediate);
    ui.node.widgets[1].value = true;
    ui.node.widgets[1].callback();
    finish({ files: ["stale.safetensors"] });
    await pending;
    assert.deepEqual(ui.state().files, []);
    assert.equal(ui.state().recursive, true);
    assert.equal(ui.scan.disabled, false);
});

test("scan errors are visible and allow retry", async () => {
    const ui = await setup();
    ui.setResponse({ ok: false, json: async () => ({ error: "Directory not found" }) });
    await ui.scan.events.click();
    assert.equal(ui.status.textContent, "Directory not found");
    assert.equal(ui.scan.disabled, false);
});
