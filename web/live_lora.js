import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Submit only this node and its dependencies, never unrelated output branches.
function previewGraph(output, nodeId, action) {
    const graph = {};
    function visit(id) {
        if (graph[id]) return;
        if (!output[id]) throw new Error("Live tuner is missing from the workflow prompt.");
        graph[id] = structuredClone(output[id]);
        for (const value of Object.values(graph[id].inputs)) {
            if (Array.isArray(value) && value.length === 2 && typeof value[1] === "number" && output[String(value[0])]) visit(String(value[0]));
        }
    }
    visit(String(nodeId));
    graph[String(nodeId)].inputs.action = action;
    return graph;
}

app.registerExtension({
    name: "questionable-nodes.live-lora",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "QuestionableLiveLoRATuner") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const node = this;
            const widget = name => node.widgets.find(item => item.name === name);
            for (const name of ["block_strengths", "action"]) {
                Object.assign(widget(name), { type: "converted-widget", computeSize: () => [0, -4], draw: () => {} });
            }
            const panel = document.createElement("div");
            Object.assign(panel.style, { overflowY: "auto", padding: "8px", boxSizing: "border-box",
                color: "var(--input-text, #ddd)", background: "var(--comfy-input-bg, #222)", font: "13px sans-serif" });
            const actions = document.createElement("div");
            const status = document.createElement("div");
            status.setAttribute("role", "status");
            status.textContent = "Connect inputs, select a LoRA, then Start live preview.";
            const previews = document.createElement("div");
            Object.assign(previews.style, { display: "flex", gap: "6px" });
            const original = document.createElement("img");
            const adjusted = document.createElement("img");
            original.alt = "Reference preview (first render or pinned image)";
            adjusted.alt = "Current adjusted preview";
            for (const image of [original, adjusted]) Object.assign(image.style, { width: "49%", objectFit: "contain", maxHeight: "360px" });
            previews.append(original, adjusted);
            const sliders = document.createElement("div");
            panel.append(actions, status, previews, sliders);
            node.addDOMWidget("live_controls", "div", panel, { serialize: false, getMinHeight: () => 260, getMaxHeight: () => 1400 });
            let live = false, busy = false, pending = null, timer, pollTimer, removed = false, activeId = null;
            let currentLora = null;
            function button(text, callback) {
                const item = document.createElement("button");
                item.textContent = text;
                item.addEventListener("click", callback);
                actions.append(item);
                return item;
            }
            const start = button("Start live preview", () => {
                live = !live;
                start.textContent = live ? "Stop live preview" : "Start live preview";
                if (live) schedule("preview");
                else { pending = null; clearTimeout(timer); status.textContent = "Live preview stopped. An active render may finish."; }
            });
            button("Verify", () => schedule("verify"));
            button("Save LoRA", () => schedule("export"));
            button("Pin reference", () => { if (adjusted.src) original.src = adjusted.src; });
            button("Reset sliders", () => {
                widget("block_strengths").value = "{}";
                sliders.replaceChildren();
                node.setDirtyCanvas(true, true);
                if (live) schedule("preview");
            });
            function schedule(action) {
                pending = action;
                clearTimeout(timer);
                if (!busy) timer = setTimeout(submit, 300);
            }
            function finish() {
                activeId = null;
                busy = false;
                if (!removed && pending) timer = setTimeout(submit, 300);
            }
            async function poll(id) {
                if (removed) return;
                try {
                    const response = await api.fetchApi(`/history/${id}`);
                    if (!response.ok) throw new Error("Cannot read preview job status.");
                    const history = (await response.json())[id];
                    if (!history) { pollTimer = setTimeout(() => poll(id), 700); return; }
                    if (history.status?.status_str === "error") {
                        const failure = history.status.messages?.find(item => item[0] === "execution_error");
                        throw new Error(failure?.[1]?.exception_message ?? "Preview generation failed; see ComfyUI's console.");
                    }
                    const output = history.outputs?.[String(node.id)];
                    if (output) display(output);
                    else status.textContent = "Preview finished without an image (possibly interrupted).";
                    finish();
                } catch (error) { fail(error); }
            }
            function fail(error) {
                pending = null;
                live = false;
                start.textContent = "Start live preview";
                status.textContent = error.message;
                finish();
            }
            async function submit() {
                if (busy || !pending || removed) return;
                busy = true;
                const action = pending;
                pending = null;
                status.textContent = action === "export" ? "Saving LoRA…" : "Preview queued; waiting for GPU…";
                try {
                    const snapshot = await app.graphToPrompt();
                    const prompt = previewGraph(snapshot.output, node.id, action);
                    const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prompt, client_id: api.clientId, partial_execution_targets: [String(node.id)] }) });
                    const value = await response.json();
                    if (!response.ok) throw new Error(value.error?.message ?? JSON.stringify(value.node_errors ?? value.error));
                    activeId = value.prompt_id;
                    if (removed) {
                        await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [activeId] }) });
                        return;
                    }
                    poll(activeId);
                } catch (error) { fail(error); }
            }
            function display(message) {
                const info = message.live_lora?.[0];
                if (!info || info.lora !== widget("lora_name").value) return;
                if (currentLora !== info.lora) { original.removeAttribute("src"); currentLora = info.lora; }
                if (message.images?.length) {
                    adjusted.src = api.apiURL("/view?" + new URLSearchParams(message.images[0]));
                    if (!original.getAttribute("src")) original.src = adjusted.src;
                }
                status.textContent = info.saved ? `Saved output/${info.saved} — load at strength 1.0` : `${info.action === "verify" ? "Verified" : "Preview updated"}. ${pending ? "New settings pending." : ""}`;
                sliders.replaceChildren();
                for (const name of info.blocks) {
                    const row = document.createElement("label");
                    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" });
                    const text = document.createElement("span");
                    text.textContent = name;
                    text.style.flex = "1";
                    const range = document.createElement("input");
                    range.type = "range"; range.min = -2; range.max = 3; range.step = 0.05;
                    const number = document.createElement("input");
                    number.type = "number"; number.step = 0.05; number.style.width = "65px";
                    number.value = range.value = JSON.parse(widget("block_strengths").value)[name] ?? 1;
                    function change(source) {
                        const value = Number(source.value);
                        if (!Number.isFinite(value)) return;
                        const values = JSON.parse(widget("block_strengths").value);
                        values[name] = value;
                        widget("block_strengths").value = JSON.stringify(values);
                        number.value = range.value = value;
                        node.setDirtyCanvas(true, true);
                        if (live) schedule("preview");
                    }
                    range.addEventListener("input", () => change(range));
                    number.addEventListener("change", () => change(number));
                    row.append(text, range, number);
                    sliders.append(row);
                }
            }
            for (const item of node.widgets.filter(item => !["block_strengths", "action", "live_controls"].includes(item.name))) {
                const callback = item.callback;
                item.callback = function () {
                    callback?.apply(this, arguments);
                    if (item.name === "lora_name") {
                        widget("block_strengths").value = "{}";
                        sliders.replaceChildren();
                        original.removeAttribute("src");
                        adjusted.removeAttribute("src");
                    }
                    if (live) schedule("preview");
                };
            }
            const executed = node.onExecuted;
            node.onExecuted = function (message) { executed?.apply(this, arguments); if (!busy) display(message); };
            const remove = node.onRemoved;
            node.onRemoved = function () {
                removed = true;
                clearTimeout(timer); clearTimeout(pollTimer);
                if (activeId) api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [activeId] }) });
                remove?.apply(this, arguments);
            };
            node.setSize([620, 850]);
            return result;
        };
    },
});
