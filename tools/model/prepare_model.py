"""Turn MobileNetV2 (ONNX model zoo) into a feature extractor for card matching.

Downloads mobilenetv2-12.onnx, verifies its checksum and cuts off the ImageNet
classifier, so the model outputs the 1280-dim pooled features instead of 1000
class scores. The result is what the web scanner runs.

    python -m venv build/venv
    build/venv/Scripts/python -m pip install -r tools/model/requirements.txt
    build/venv/Scripts/python tools/model/prepare_model.py
"""

import hashlib
import urllib.request
from pathlib import Path

import onnx

MODEL_URL = (
    "https://github.com/onnx/models/raw/main/validated/vision/classification/"
    "mobilenet/model/mobilenetv2-12.onnx"
)
MODEL_SHA256 = "c0c3f76d93fa3fd6580652a45618618a220fced18babf65774ed169de0432ad5"
FEATURE_TENSOR = "472"  # output of the flatten right before the final Gemm
FEATURE_DIM = 1280

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "build" / "model" / "mobilenetv2-12.onnx"
TARGET = REPO_ROOT / "pwa" / "model" / "mobilenetv2-features.onnx"


def main():
    if not SOURCE.exists():
        print(f"Downloading {MODEL_URL}")
        SOURCE.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, SOURCE)
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        raise SystemExit(f"Checksum mismatch for {SOURCE}: {digest}")

    model = onnx.load(str(SOURCE))
    graph = model.graph
    # The classifier is the last node; drop it and its weights, then expose its input as output.
    classifier = graph.node[-1]
    assert classifier.op_type == "Gemm" and classifier.input[0] == FEATURE_TENSOR, classifier
    graph.node.remove(classifier)
    for name in classifier.input[1:]:
        graph.initializer.remove(next(t for t in graph.initializer if t.name == name))
    del graph.output[:]
    graph.output.append(
        onnx.helper.make_tensor_value_info(FEATURE_TENSOR, onnx.TensorProto.FLOAT, ["batch_size", FEATURE_DIM])
    )
    onnx.checker.check_model(model)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(TARGET))
    dims = [d.dim_value or d.dim_param for d in model.graph.output[0].type.tensor_type.shape.dim]
    print(f"Wrote {TARGET} (output {model.graph.output[0].name}: {dims})")


if __name__ == "__main__":
    main()
