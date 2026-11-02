import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function trainerExport(info, values, strength, format) {
    if (!info) throw new Error("Start a preview to discover the current LoRA's blocks first.");
    const effective = Object.fromEntries(info.blocks.map(name => [name, strength * (values[name] ?? 1)]));
    if (format === "exact") return JSON.stringify({ strength, block_strengths: Object.fromEntries(info.blocks.map(name => [name, values[name] ?? 1])), effective_strengths: effective }, null, 2);
    const targets = info.trainer_targets;
    if (!targets) throw new Error("Run a new preview to discover trainer layer names.");
    const active = info.blocks.filter(name => effective[name] !== 0);
    if (!active.length) throw new Error("All blocks are off. No trainable layer selection can be exported.");
    const diffusers = format === "onetrainer" || (format === "ai_toolkit" && targets.family !== "krea2");
    const mapping = diffusers ? targets.diffusers : targets.native;
    if (active.some(name => !mapping[name]?.length)) throw new Error("Some active layers have no verified trainer mapping. Use Exact adjustments JSON instead.");
    const names = [...new Set(active.flatMap(name => mapping[name]))].sort();
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (format === "ai_toolkit") {
        if (!["krea2", "flux", "flux2", "sdxl"].includes(targets.family)) throw new Error("AI Toolkit mapping is verified for Krea 2, FLUX, FLUX.2, and SDXL only.");
        return JSON.stringify({ network: { network_kwargs: { only_if_contains: names } } }, null, 2);
    }
    if (format === "onetrainer") return JSON.stringify({ layer_filter: `^(?:${names.map(escape).join("|")})$`, layer_filter_regex: true }, null, 2);
    if (format === "musubi") return JSON.stringify({ network_args: ["exclude_patterns=['.*']", `include_patterns=${JSON.stringify(names.map(name => escape(name)))}`] }, null, 2);
    if (format === "kohya") {
        if (targets.family !== "flux" || info.blocks.some(name => !/^(double_blocks|single_blocks)\.\d+$/.test(name))) {
            throw new Error("Kohya FLUX block selection requires FLUX.1 with only double/single blocks. Other layouts have no equivalent supported snippet.");
        }
        return JSON.stringify({ network_args: ["train_double_block_indices=" + (active.filter(name => name.startsWith("double_blocks.")).map(name => name.split(".").at(-1)).join(",") || "none"),
            "train_single_block_indices=" + (active.filter(name => name.startsWith("single_blocks.")).map(name => name.split(".").at(-1)).join(",") || "none")] }, null, 2);
    }
    throw new Error("Unknown trainer format.");
}

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
            let currentLora = null, lastInfo = null, savedPresets = [];
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
                if (lastInfo) display({ live_lora: [lastInfo] });
                else sliders.replaceChildren();
                node.setDirtyCanvas(true, true);
                updateExport();
                if (live) schedule("preview");
            });
            const presets = document.createElement("div");
            const presetName = document.createElement("input");
            presetName.placeholder = "Preset name (same name replaces it)";
            presetName.setAttribute("aria-label", "Preset name");
            const presetList = document.createElement("select");
            presetList.setAttribute("aria-label", "Saved adjustment presets");
            function presetButton(text, action) {
                const item = document.createElement("button");
                item.textContent = text;
                item.addEventListener("click", action);
                presets.append(item);
            }
            presets.append(presetName, presetList);
            async function refreshPresets(selected) {
                const response = await api.fetchApi("/questionable-nodes/tuner/presets");
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "Cannot load presets.");
                savedPresets = data;
                presetList.replaceChildren();
                for (const preset of data) {
                    const option = document.createElement("option");
                    option.value = option.textContent = preset.name;
                    presetList.append(option);
                }
                if (selected) presetList.value = selected;
            }
            presetButton("Refresh presets", async () => {
                try { await refreshPresets(presetList.value); status.textContent = `${savedPresets.length} presets loaded.`; }
                catch (error) { status.textContent = error.message; }
            });
            presetButton("Save preset", async () => {
                try {
                    if (!lastInfo) throw new Error("Start a preview before saving a preset.");
                    const response = await api.fetchApi("/questionable-nodes/tuner/presets", { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: presetName.value, values: JSON.parse(widget("block_strengths").value), strength: widget("strength").value, blocks: lastInfo.blocks }) });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error ?? "Cannot save preset.");
                    await refreshPresets(data.name);
                    status.textContent = `Saved preset: ${data.name}`;
                } catch (error) { status.textContent = error.message; }
            });
            presetButton("Apply preset", () => {
                try {
                    const preset = savedPresets.find(item => item.name === presetList.value);
                    if (!preset) throw new Error("Refresh presets and select one first.");
                    if (!lastInfo || JSON.stringify([...lastInfo.blocks].sort()) !== JSON.stringify([...preset.blocks].sort())) throw new Error("Start a preview with a LoRA whose block layout matches this preset.");
                    widget("block_strengths").value = JSON.stringify(preset.values);
                    widget("strength").value = preset.strength;
                    node.setDirtyCanvas(true, true);
                    display({ live_lora: [lastInfo] });
                    status.textContent = `Applied preset: ${preset.name}`;
                    updateExport();
                    if (live) schedule("preview");
                } catch (error) { status.textContent = error.message; }
            });
            const exportPanel = document.createElement("div");
            const format = document.createElement("select");
            format.setAttribute("aria-label", "Trainer export format");
            for (const [value, label] of [["exact", "Exact adjustments JSON"], ["ai_toolkit", "AI Toolkit — layer selection"], ["onetrainer", "OneTrainer — layer selection"], ["musubi", "Musubi — native layer selection"], ["kohya", "Kohya / sd-scripts — FLUX.1 blocks"]]) {
                const option = document.createElement("option");
                option.value = value; option.textContent = label; format.append(option);
            }
            format.value = "exact";
            const note = document.createElement("div");
            const text = document.createElement("textarea");
            text.readOnly = true; text.rows = 9; text.style.width = "100%"; text.style.boxSizing = "border-box";
            text.setAttribute("aria-label", "Copyable layer adjustment settings");
            function updateExport() {
                note.textContent = format.value === "exact" ? "Exact inference multipliers; this JSON is not a trainer config." : "Merge this fragment into your trainer config. Selects nonzero layers only; fractional/negative strengths are NOT reproduced. Existing trainer filters and supported model targets still apply.";
                try { text.value = trainerExport(lastInfo, JSON.parse(widget("block_strengths").value), widget("strength").value, format.value); }
                catch (error) { text.value = ""; note.textContent = error.message; }
            }
            const copy = document.createElement("button");
            copy.textContent = "Copy settings";
            copy.addEventListener("click", async () => {
                try { await navigator.clipboard.writeText(text.value); status.textContent = "Settings copied."; }
                catch { text.focus(); text.select(); status.textContent = "Press Ctrl+C to copy the selected settings."; }
            });
            format.addEventListener("change", updateExport);
            exportPanel.append(format, copy, note, text);
            panel.append(presets, exportPanel);
            updateExport();
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
                lastInfo = info;
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
                        updateExport();
                        if (live) schedule("preview");
                    }
                    range.addEventListener("input", () => change(range));
                    number.addEventListener("change", () => change(number));
                    row.append(text, range, number);
                    sliders.append(row);
                }
                updateExport();
            }
            for (const item of node.widgets.filter(item => !["block_strengths", "action", "live_controls"].includes(item.name))) {
                const callback = item.callback;
                item.callback = function () {
                    callback?.apply(this, arguments);
                    if (item.name === "lora_name") {
                        lastInfo = null;
                        widget("block_strengths").value = "{}";
                        sliders.replaceChildren();
                        original.removeAttribute("src");
                        adjusted.removeAttribute("src");
                    }
                    updateExport();
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
