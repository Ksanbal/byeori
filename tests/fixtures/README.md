# Synthetic planning fixtures

The nine YAML documents in `planning/` are the selected synthetic examples from Byeori build pack v1.2.0 (`examples/planning/`). They contain invented product data, including Korean example text; they do not contain real welfare or user records. Tests read these standalone files and never read `.inputs` at runtime.

`ownership-child.ts` is an actual temporary-workspace child process used only by ownership tests. It pauses under the ordinary writer lock and writes a harmless progress file when resumed. It has no review, approval, or apply bypass.
