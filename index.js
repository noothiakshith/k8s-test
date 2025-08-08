import express from "express";
import * as k8s from "@kubernetes/client-node";

const app = express();
app.use(express.json());

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

app.post('/run-code', async (req, res) => {
  const { language, code } = req.body;

  console.log("Received request with language:", language);

  if (typeof code !== "string" || code.length > 1000) {
    console.log("Invalid code input");
    return res.status(400).json({ error: "Invalid or too long code" });
  }
  if (!["python", "node", "sh"].includes(language)) {
    console.log("Unsupported language:", language);
    return res.status(400).json({ error: "Unsupported language" });
  }

  const podName = `code-runner-${Date.now()}`;
  const namespace = "default";

  const image =
    language === "python" ? "python:3.11" :
    language === "node" ? "node:22" : "alpine";

  const command =
    language === "python" ? ["python", "-c", code] :
    language === "node" ? ["node", "-e", code] : ["sh", "-c", code];

  const podManifest = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
    },
    spec: {
      containers: [
        {
          name: "runner",
          image,
          command,
          resources: {
            limits: {
              cpu: "500m",
              memory: "128Mi",
            },
          },
        },
      ],
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 5,  // give 5 seconds for graceful shutdown
    },
  };

  console.log("Creating pod:", podName);

  let podFailed = false;
  let failureReason = "Execution failed";

  try {
    await k8sApi.createNamespacedPod({ namespace, body: podManifest });
    console.log("Pod creation request sent");

    const maxWaitMs = 10000;
    const pollIntervalMs = 500;
    const start = Date.now();
    let phase = "";

    while (true) {
      const pod = await k8sApi.readNamespacedPodStatus({ name: podName, namespace });
      phase = pod.status?.phase;
      console.log(`Pod phase: ${phase}`);

      if (phase === "Succeeded" || phase === "Failed") {
        if (phase === "Failed") {
          podFailed = true;
          console.log("Pod execution failed");
        } else {
          console.log("Pod execution succeeded");
        }
        break;
      }

      const containerStatus = pod.status?.containerStatuses?.[0];
      const waitingState = containerStatus?.state?.waiting;
      if (
        waitingState &&
        ["CreateContainerConfigError", "ImagePullBackOff", "ErrImagePull"].includes(waitingState.reason)
      ) {
        podFailed = true;
        failureReason = waitingState.message || waitingState.reason;
        console.log("Pod container waiting with failure reason:", failureReason);
        break;
      }

      if (Date.now() - start > maxWaitMs) {
        console.log("Pod execution timed out, deleting pod");
        await k8sApi.deleteNamespacedPod({ name: podName, namespace, body: {} });
        return res.status(504).json({ error: "Execution timed out" });
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    console.log("Fetching logs from pod:", podName);
    let logs = "";
    try {
      const logsResponse = await k8sApi.readNamespacedPodLog({ name: podName, namespace, container: "runner" });
      logs = logsResponse.body || "";
      console.log("Pod logs fetched:", logs);
    } catch (logErr) {
      console.error("Failed to read pod logs:", logErr);
      logs = "(failed to fetch logs)";
    }

    console.log("Deleting pod:", podName);
    await k8sApi.deleteNamespacedPod({ name: podName, namespace, body: {} });
    console.log("Pod deleted");

    if (podFailed) {
      console.log("Returning failure response");
      return res.status(422).json({ error: failureReason, output: logs });
    }

    if (!logs.trim()) {
      console.log("No output from pod logs");
      return res.status(200).json({ output: "(no output)" });
    }

    console.log("Returning success response");
    res.json({ output: logs });
  } catch (err) {
    console.error("Error during pod lifecycle:", err);

    try {
      console.log("Attempting to cleanup pod due to error");
      await k8sApi.deleteNamespacedPod({ name: podName, namespace, body: {} });
      console.log("Cleanup pod succeeded");
    } catch (e) {
      if (e.statusCode !== 404) {
        console.error("Pod cleanup failed:", e.body?.message || e.message);
      }
    }

    const errorMessage = err.body?.message || err.message;
    res.status(500).json({ error: "Failed to run code", details: errorMessage });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
