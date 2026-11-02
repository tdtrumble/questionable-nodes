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
            const selectAll = document.createElement("button");
            selectAll.textContent = "Select All";
            selectAll.style.cursor = "pointer";
            const actions = document.createElement("div");
            Object.assign(actions.style, { display: "flex", gap: "6px" });
            scan.style.flex = selectAll.style.flex = "1";
            actions.append(scan, selectAll);
            const status = document.createElement("div");
            status.setAttribute("role", "status");
            const list = document.createElement("div");
            Object.assign(list.style, { overflowY: "auto", flex: "1", minHeight: "0" });
            panel.append(actions, status, list);
            node.addDOMWidget("lora_files", "div", panel, {
                serialize: false, getMinHeight: () => 180, getMaxHeight: () => 500,
            });

            let scanId = 0;
            let draggedName = null;
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
                selectAll.disabled = !files.length;
                selectAll.textContent = files.length && files.every(name => checked.has(name)) ? "Deselect All" : "Select All";
                status.textContent = files.length
                    ? `${checked.size} selected / ${files.length} files`
                    : "Click Scan to list LoRA files. Select at least one.";
                for (const name of files) {
                    const row = document.createElement("label");
                    row.title = "Drag the handle to change run order (top to bottom).";
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
                        selectAll.textContent = current.selected.length === current.files.length ? "Deselect All" : "Select All";
                    });
                    const handle = document.createElement("span");
                    handle.textContent = "⠿";
                    handle.draggable = true;
                    handle.title = "Drag to reorder";
                    handle.style.cursor = "grab";
                    handle.addEventListener("click", event => event.preventDefault());
                    handle.addEventListener("dragstart", event => {
                        draggedName = name;
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", name);
                        event.stopPropagation();
                    });
                    handle.addEventListener("dragend", () => {
                        draggedName = null;
                        for (const item of list.children) item.style.boxShadow = "";
                    });
                    row.addEventListener("dragover", event => {
                        if (draggedName === null || draggedName === name) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        const bounds = row.getBoundingClientRect();
                        row.style.boxShadow = event.clientY < bounds.top + bounds.height / 2
                            ? "inset 0 2px #888" : "inset 0 -2px #888";
                    });
                    row.addEventListener("dragleave", () => { row.style.boxShadow = ""; });
                    row.addEventListener("drop", event => {
                        if (draggedName === null) return;
                        event.preventDefault();
                        event.stopPropagation();
                        row.style.boxShadow = "";
                        if (draggedName === name) return;
                        const current = readState();
                        const files = current.files.filter(file => file !== draggedName);
                        const bounds = row.getBoundingClientRect();
                        const after = event.clientY >= bounds.top + bounds.height / 2;
                        files.splice(files.indexOf(name) + (after ? 1 : 0), 0, draggedName);
                        const selected = new Set(current.selected);
                        current.files = files;
                        current.selected = files.filter(file => selected.has(file));
                        draggedName = null;
                        writeState(current);
                        const scrollTop = list.scrollTop;
                        render();
                        list.scrollTop = scrollTop;
                    });
                    row.append(checkbox, handle, document.createTextNode(name));
                    list.append(row);
                }
            }
            selectAll.addEventListener("click", () => {
                const state = readState();
                const files = state.files ?? [];
                const checked = new Set(state.selected ?? []);
                state.selected = files.every(name => checked.has(name)) ? [] : [...files];
                writeState(state);
                render();
            });
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
                selectAll.disabled = true;
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
                    const sameSettings = previous.directory === settings.directory && previous.recursive === settings.recursive;
                    const keep = new Set(sameSettings ? previous.selected ?? [] : []);
                    const available = new Set(data.files);
                    const retained = sameSettings ? (previous.files ?? []).filter(name => available.has(name)) : [];
                    const retainedSet = new Set(retained);
                    const files = [...retained, ...data.files.filter(name => !retainedSet.has(name))];
                    writeState({ ...settings, files, selected: files.filter(name => keep.has(name)) });
                    render();
                    if (!data.files.length) status.textContent = "No LoRA files found in this directory.";
                } catch (error) {
                    if (id === scanId) status.textContent = error.message;
                } finally {
                    if (id === scanId) {
                        scan.disabled = false;
                        selectAll.disabled = !(readState().files?.length);
                    }
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
