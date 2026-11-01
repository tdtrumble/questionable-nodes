import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "questionable-nodes.lora-audition",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "QuestionableLoRAAudition") return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;
            const directory = node.widgets.find(w => w.name === "directory");
            const recursive = node.widgets.find(w => w.name === "recursive");
            const selection = node.widgets.find(w => w.name === "selection");
            selection.type = "converted-widget";
            selection.computeSize = () => [0, -4];
            selection.draw = () => {};

            const panel = document.createElement("div");
            Object.assign(panel.style, {
                display: "flex", flexDirection: "column", gap: "6px", padding: "8px",
                boxSizing: "border-box", color: "var(--input-text, #ddd)",
                background: "var(--comfy-input-bg, #222)", font: "13px sans-serif",
            });
            const scan = document.createElement("button");
            scan.textContent = "Scan";
            scan.style.cursor = "pointer";
            const status = document.createElement("div");
            status.setAttribute("role", "status");
            const list = document.createElement("div");
            Object.assign(list.style, { overflowY: "auto", flex: "1", minHeight: "0" });
            panel.append(scan, status, list);
            node.addDOMWidget("lora_files", "div", panel, {
                serialize: false, getMinHeight: () => 180, getMaxHeight: () => 500,
            });

            let scanId = 0;
            function readState() {
                try { return JSON.parse(selection.value); }
                catch { return { selected: [] }; }
            }
            function writeState(state) {
                selection.value = JSON.stringify(state);
                node.setDirtyCanvas(true, true);
            }
            function render() {
                const state = readState();
                list.replaceChildren();
                const files = state.files ?? [];
                const checked = new Set(state.selected ?? []);
                status.textContent = files.length
                    ? `${checked.size} selected / ${files.length} files`
                    : "Click Scan to list LoRA files. Select at least one.";
                for (const name of files) {
                    const row = document.createElement("label");
                    Object.assign(row.style, {
                        display: "flex", alignItems: "center", gap: "6px", padding: "3px 0",
                        overflowWrap: "anywhere", cursor: "pointer",
                    });
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = checked.has(name);
                    checkbox.addEventListener("change", () => {
                        const current = readState();
                        const selected = new Set(current.selected ?? []);
                        if (checkbox.checked) selected.add(name);
                        else selected.delete(name);
                        current.selected = current.files.filter(file => selected.has(file));
                        writeState(current);
                        status.textContent = `${current.selected.length} selected / ${current.files.length} files`;
                    });
                    row.append(checkbox, document.createTextNode(name));
                    list.append(row);
                }
            }
            function reset() {
                scanId++;
                scan.disabled = false;
                writeState({ directory: directory.value, recursive: recursive.value, files: [], selected: [] });
                render();
            }
            for (const widget of [directory, recursive]) {
                const callback = widget.callback;
                widget.callback = function () {
                    callback?.apply(this, arguments);
                    reset();
                };
            }
            scan.addEventListener("click", async () => {
                const id = ++scanId;
                const settings = { directory: directory.value, recursive: recursive.value };
                scan.disabled = true;
                status.textContent = "Scanning…";
                try {
                    const response = await api.fetchApi("/questionable-nodes/loras/scan", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(settings),
                    });
                    const data = await response.json();
                    if (id !== scanId) return;
                    if (!response.ok) throw new Error(data.error ?? "Directory scan failed.");
                    const previous = readState();
                    const keep = previous.directory === settings.directory && previous.recursive === settings.recursive
                        ? new Set(previous.selected ?? []) : new Set();
                    writeState({ ...settings, files: data.files, selected: data.files.filter(name => keep.has(name)) });
                    render();
                    if (!data.files.length) status.textContent = "No LoRA files found in this directory.";
                } catch (error) {
                    if (id === scanId) status.textContent = error.message;
                } finally {
                    if (id === scanId) scan.disabled = false;
                }
            });
            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                render();
            };
            render();
            node.setSize([360, Math.max(node.size[1], 430)]);
            return result;
        };
    },
});
