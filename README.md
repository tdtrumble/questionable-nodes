# Questionable Nodes

Useful nodes. Questionable organization.

An eclectic collection of practical ComfyUI nodes.

## Installation

Place this folder in `ComfyUI/custom_nodes/questionable-nodes`, restart ComfyUI,
and refresh the browser. Requires a current ComfyUI with the V3 node API.
No additional Python packages are needed. Registry/Manager publication is not configured.

To reinstall from GitHub, run this from your ComfyUI directory (requires access to the repository):

```sh
git clone https://github.com/tdtrumble/questionable-nodes.git custom_nodes/questionable-nodes
```

## LoRA Audition

Find **LoRA Audition** under **Questionable Nodes/loaders**.

1. Connect the incoming MODEL. CLIP is optional; leave it disconnected for model-only LoRAs.
2. Enter a directory on the machine running ComfyUI. Enable **recursive** to include subfolders.
3. Click **Scan**, then check the LoRAs you want to compare, or click **Select All**.
   New files start unchecked. Select All is available when the scan has results.
   When every file is checked, the button becomes **Deselect All**; click again to clear the selection.
4. Drag the handle beside a filename to reorder the list. Checked LoRAs run from top to bottom.
   Set the shared model and CLIP strengths (CLIP strength only applies when CLIP is connected).
5. Connect MODEL to your sampler and, if supplied, CLIP to your text encoders. Optionally connect
   **filename** to Save Image's `filename_prefix` (convert that widget to an input).
6. Run the workflow once. An empty selection produces a validation error.

Each selected LoRA is applied independently to the incoming model and CLIP;
the selections are not stacked. The three outputs are aligned ComfyUI lists.
Native downstream generation nodes process each entry in one queued job.
Shared upstream work is reused, and the sampler's seed is shared across entries.
A latent batch of N produces N images per LoRA. Nodes that explicitly consume
or combine whole lists can change this behavior. Execution is not necessarily
one complete generation chain at a time, and selected LoRA patches remain in
memory for the job. Start with a small selection for large LoRAs.

The first scan sorts files alphabetically. Recursive results show relative paths. Rescanning
preserves the order and selections of files still present and appends new files unchecked;
changing the directory or recursive setting clears them. Workflows retain the scan
results, order, and selections. The filename output
contains the file's basename without its extension; identical basenames in different
subfolders therefore share a prefix (Save Image adds its normal counter).

The scan uses ComfyUI's supported weight extensions; files must actually contain
LoRA weights compatible with the incoming model. Paths and selected files are
checked again during execution. File size and modification time invalidate cached
outputs when a selected file changes. No external services or downloads are used.

## Audition Prompt List and Audition Review

Add both nodes from **Questionable Nodes/audition**. Prompt List supports any number
of multiline prompts; use **Add prompt**, **Remove**, and the arrow buttons to edit
their order. Blank entries are skipped. The seed is fixed across all candidates.

Connect these sockets:

1. Prompt List **prompts** → LoRA Audition **prompts**.
2. Audition **prompt** → positive text encoder's text input (convert its widget to an input).
3. Audition **MODEL** → sampler model; **seed** → sampler seed/noise seed input.
4. If using CLIP LoRAs, Audition **CLIP** → positive and negative text encoders.
   Otherwise, connect your text encoder loader directly to those encoders.
5. Sampler → VAE Decode → Review **images**.
6. Audition **comparison** → Review **comparison**.

Queue once. Every prompt runs against every checked LoRA, in prompt order then
LoRA order. Models are patched once per LoRA and reused across prompts. Each Review
card shows one prompt/sample with a discrete slider through the candidates.
Latent batches produce separate cards per sample. Keep the image and comparison
lists aligned: do not combine, filter, or reorder just one of them downstream.

Use **Choose this** to vote for the displayed checkpoint, or **Skip** to clear a
vote. Browsing the slider does not vote. **Update ranking** saves choices and
recalculates the ranking without generating images. Repeated saves replace votes
rather than adding them. Equal selection counts share a rank; Entered counts only
scored comparisons where that checkpoint was a candidate.

Enter a session name to collect multiple runs together. **Load session** restores
saved cards, images, and votes; saved workflows also reload their named session.
New workflow executions append cards, including when generation results are cached.
Save choices before loading a session or switching names. New results arriving in
the current session retain pending choices.

The candidate-set filter separates comparisons with different checkpoint sets.
Reordering the same set does not create a new group. Checkpoints are identified
by resolved path and SHA-256 file content, so replacing a file creates a new identity.
Rankings show a short identity suffix to distinguish matching names. Overall totals
across different opponent sets are descriptive, not a controlled head-to-head score.

Sessions live in `output/audition_sessions/*.json`; images live in `output/audition/`.
Back up both folders to preserve reviews. Session names are hashed into safe filenames.
All persistence and requests stay on your ComfyUI server. No new dependencies are needed.

## Live LoRA Tuner

Find **Live LoRA Tuner** under **Questionable Nodes/audition**. Connect an incoming
MODEL without the LoRA you are tuning, positive/negative CONDITIONING, an empty or
encoded LATENT, and VAE. Choose a LoRA from the normal `models/loras` list. Connect
your text encoder directly to the conditioning nodes: this tuner adjusts the
model-side LoRA only, not text-encoder weights.

Click **Start live preview**. The first image discovers the loaded LoRA's native
model blocks and creates their sliders. Moving sliders or editing numeric weights
automatically queues another preview after a 300 ms pause. Only one preview job
per tuner is outstanding; edits during generation collapse into one latest-settings
update. Other workflow output branches are excluded. **Stop live preview** stops
new automatic jobs; an already queued/running job may finish. Removing the node
also attempts to delete its pending job without interrupting other GPU work.

The left image is the first-render reference; the right image is the latest result.
**Pin reference** replaces the reference with the current image. **Reset sliders**
restores all block multipliers to 1. Sliders cover -2 to 3; numeric fields accept
other finite values. The shared strength multiplies each block's setting.
Block names come from native model patch targets, including Krea 2's main blocks
and text-fusion blocks. Unclassified targets are grouped as `other_weights`.

Set preview steps, verification steps, CFG, sampler, scheduler, and denoise for
your model. Four steps/CFG 1 are defaults intended for accelerated models, not a
quality guarantee. **Verify** renders with verification steps and the original
latent. An optional smaller **preview_latent** accelerates previews while keeping
verification at your target dimensions. The seed stays fixed between updates.
**tuned_model** can feed your own generation chain using the same block settings.

**Save LoRA** writes a new file under `output/audition_loras/`, with the shared and
block strengths baked in; load it at strength 1.0. Standard LoRA/LoCon up/down
factors are supported for export; DoRA and other adapter formats are rejected
rather than exported with incorrect strength math. Text-encoder tensors, if present,
remain unchanged and are not represented in model-only previews. Move the exported
file into a model LoRA folder to select it in loaders.

Updates are real GPU renders through ComfyUI's normal queue, sampling, model
patching, and offloading. Upstream workflow caching is reused, but there is no
model-internal activation cache or instantaneous-refresh guarantee. The LoRA is
read again when settings change, rather than kept in an additional tensor cache.
Wait time depends on hardware, model, steps, latent size, and other queued work.
Live mode starts stopped after reopening a workflow; saved block values persist.

## Development checks

From the ComfyUI directory, using its Python environment:

```sh
python -m unittest discover -s custom_nodes/questionable-nodes/tests -v
node --test custom_nodes/questionable-nodes/tests/*.test.cjs
```

Backend checks cover scanning, selection validation, cache invalidation, independent
LoRA application, and native list mapping with a shared seed. LoRA loading is mocked
in the unit tests; image generation should also be checked with your own compatible weights.
