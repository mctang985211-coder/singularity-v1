"""Finite public oracle: call the pinned software; never evaluate candidate code."""
import contextlib
import json
import math
import sys
from pathlib import Path


def evaluate(project, case):
    import numpy as np
    import torch

    torch.set_num_threads(2)
    torch.set_num_interop_threads(2)
    torch.set_default_dtype(torch.float32)
    torch.manual_seed(case["seed"])
    np.random.seed(case["seed"])
    stage = case["stage"]
    checkpoint = Path(project["checkpoint"]["path"])

    def tensor(name, dtype=torch.float32):
        value = case["tensors"][name]
        return torch.tensor(value["values"], dtype=dtype).reshape(value["shape"])

    if stage in ("campplus", "tokenizer.codes", "tokenizer.features"):
        import onnx
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 2
        if stage == "campplus":
            model = str(checkpoint / "campplus.onnx")
            feeds = {"input": tensor("feats").numpy()}
            output = None
        else:
            model = str(checkpoint / "speech_tokenizer_v3.onnx")
            feeds = {"feats": tensor("feats").numpy(),
                     "feats_length": tensor("feats_length", torch.int32).numpy()}
            output = None
            if stage == "tokenizer.features":
                graph = onnx.load(model)
                output = ["/blocks.11/Add_1_output_0"]
                graph.graph.output.append(onnx.helper.make_tensor_value_info(output[0], onnx.TensorProto.FLOAT, None))
                model = graph.SerializeToString()
        session = ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])
        return session.run(output, feeds)[0].reshape(-1).tolist()

    source = Path(project["cosyvoice"]["path"])
    sys.path[:0] = [str(source), str(source / "third_party/Matcha-TTS")]
    from hyperpyyaml import load_hyperpyyaml

    component = "flow" if stage.startswith("flow.") else "hift" if stage == "hift" else "llm"
    overrides = {name: None for name in ("llm", "flow", "hift") if name != component}
    overrides["qwen_pretrain_path"] = str(checkpoint / "CosyVoice-BlankEN")
    with (checkpoint / "cosyvoice3.yaml").open() as stream:
        model = load_hyperpyyaml(stream, overrides=overrides)[component]
    model.load_state_dict(torch.load(checkpoint / (component + ".pt"), map_location="cpu", weights_only=True, mmap=True), strict=True)
    model.float().eval()
    # YAML initialization seeds model construction; the case owns inference RNG.
    torch.manual_seed(case["seed"])
    np.random.seed(case["seed"])
    with torch.inference_mode():
        if stage == "flow.velocity":
            result = model.decoder.estimator(tensor("x"), tensor("mask"), tensor("mu"), tensor("t"),
                                             tensor("spks"), tensor("cond"), streaming=case["streaming"])
        elif stage == "flow.euler":
            times = torch.linspace(0, 1, case["nTimesteps"] + 1)
            if model.decoder.t_scheduler == "cosine":
                times = 1 - torch.cos(times * 0.5 * torch.pi)
            result = model.decoder.solve_euler(tensor("x"), times, tensor("mu"), tensor("mask"),
                                               tensor("spks"), tensor("cond"), streaming=case["streaming"])
        elif stage == "hift":
            result = model.inference(tensor("mel"), finalize=case["finalize"])[0]
        elif stage == "llm.hidden":
            result = model.llm(tensor("embeddings"), tensor("lengths", torch.int64))[0]
        elif stage == "llm.logits":
            hidden = model.llm(tensor("embeddings"), tensor("lengths", torch.int64))[0]
            result = model.llm_decoder(hidden)
        else:
            raise ValueError("Unsupported native oracle stage: " + stage)
    return result.reshape(-1).tolist()


if __name__ == "__main__":
    project = json.loads(Path(sys.argv[1]).read_text())
    case = json.load(sys.stdin)
    # Native libraries may print diagnostics; stdout is the numeric result only.
    with contextlib.redirect_stdout(sys.stderr):
        values = evaluate(project, case)
    if not values or not all(math.isfinite(value) for value in values):
        print("Native oracle produced empty or nonfinite numerical output", file=sys.stderr)
        sys.exit(3)
    print(json.dumps(values, allow_nan=False))
