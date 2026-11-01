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

1. Connect the incoming MODEL and CLIP, as with the standard LoRA loader.
2. Enter a directory on the machine running ComfyUI. Enable **recursive** to include subfolders.
3. Click **Scan**, then check the LoRAs you want to compare. New files start unchecked.
4. Set the shared model and CLIP strengths.
5. Connect MODEL to your sampler and CLIP to your text encoders. Optionally connect
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

Files are sorted alphabetically. Recursive results show relative paths. Rescanning
preserves selections still present; changing the directory or recursive setting
clears them. Workflows retain the scan results and selections. The filename output
contains the file's basename without its extension; identical basenames in different
subfolders therefore share a prefix (Save Image adds its normal counter).

The scan uses ComfyUI's supported weight extensions; files must actually contain
LoRA weights compatible with the incoming model. Paths and selected files are
checked again during execution. File size and modification time invalidate cached
outputs when a selected file changes. No external services or downloads are used.

## Development checks

From the ComfyUI directory, using its Python environment:

```sh
python -m unittest discover -s custom_nodes/questionable-nodes/tests -v
node --test custom_nodes/questionable-nodes/tests/frontend.test.cjs
```

Backend checks cover scanning, selection validation, cache invalidation, independent
LoRA application, and native list mapping with a shared seed. LoRA loading is mocked
in the unit tests; image generation should also be checked with your own compatible weights.
