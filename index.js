import express from "express";
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";

const app = express();
const port = 3000;

app.use(express.json());

const kc = new KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(CoreV1Api);

// Language → image mapping
const languageConfig = {
    python: { image: "python:3.10", ext: "py", cmd: "python" },
    node: { image: "node:18", ext: "js", cmd: "node" },
    go: { image: "golang:1.20", ext: "go", cmd: "go run" },
    java: { image: "openjdk:17", ext: "java", cmd: "sh -c 'javac Main.java && java Main'" }
};

app.post("/run-code", async (req, res) => {
    try {
        const { language, code } = req.body;
        if (!languageConfig[language]) return res.status(400).json({ error: "Invalid language" });

        const { image, ext, cmd } = languageConfig[language];
        const podName = `code-run-${Math.floor(Math.random() * 10000)}`;

        const safeCode = code.replace(/'/g, "'\"'\"'");
        const runCommand = `echo '${safeCode}' > /tmp/script.${ext} && ${cmd} /tmp/script.${ext}`;

        const podManifest = {
            metadata: { name: podName },
            spec: {
                containers: [{
                    name: "runner",
                    image: image,
                    command: ["sh", "-c", runCommand]
                }],
                restartPolicy: "Never"
            }
        };

        await k8sApi.createNamespacedPod("default", podManifest);

        let phase = "";
        while (phase !== "Succeeded" && phase !== "Failed") {
            const { body } = await k8sApi.readNamespacedPod(podName, "default");
            phase = body.status.phase;
            await new Promise(r => setTimeout(r, 1000));
        }

        const logs = await k8sApi.readNamespacedPodLog(podName, "default", "runner");

        await k8sApi.deleteNamespacedPod(podName, "default");

        res.json({ output: logs.body });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

app.listen(port, () => {
    console.log(`🚀 App running at http://localhost:${port}`);
});
