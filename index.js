
import express from "express";
import * as k8s from "@kubernetes/client-node";

const app = express();
app.use(express.json());

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

app.post('/run-code', async (req, res) => {
  const { language, code } = req.body;

  if (typeof code !== "string" || code.length > 1000) {
    return res.status(400).json({ error: "Invalid or too long code" });
  }
  if (!["python", "node", "sh"].includes(language)) {
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
    },
  };

  let podFailed = false;
  let failureReason = "Execution failed";

  try {
    // This call adheres to the CoreV1ApiCreateNamespacedPodRequest type.
    await k8sApi.createNamespacedPod({ namespace, body: podManifest });

    const maxWaitMs = 10000;
    const pollIntervalMs = 500;
    const start = Date.now();

    while (true) {
      // This call adheres to the CoreV1ApiReadNamespacedPodStatusRequest type.
      // It correctly awaits the V1Pod object directly, as specified by the return type.
      const pod = await k8sApi.readNamespacedPodStatus({ name: podName, namespace, });
      const phase = pod.status?.phase;

      if (phase === "Succeeded" || phase === "Failed") {
        if (phase === "Failed") podFailed = true;
        break;
      }

      // Check for unrecoverable container states to fail fast.
      const containerStatus = pod.status?.containerStatuses?.[0];
      const waitingState = containerStatus?.state?.waiting;
      if (waitingState && ['CreateContainerConfigError', 'ImagePullBackOff', 'ErrImagePull'].includes(waitingState.reason)) {
          podFailed = true;
          failureReason = waitingState.message || waitingState.reason;
          break;
      }

      if (Date.now() - start > maxWaitMs) {
        await k8sApi.deleteNamespacedPod({ name: podName, namespace });
        return res.status(504).json({ error: "Execution timed out" });
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    // Note: readNamespacedPodLog uses a different signature (positional args)
    // and returns a different object structure ({ response, body }).
    const logsResponse = await k8sApi.readNamespacedPodLog(podName, namespace, "runner");
    const logs = logsResponse.body;

    // This call adheres to the CoreV1ApiDeleteNamespacedPodRequest type.
    await k8sApi.deleteNamespacedPod({ name: podName, namespace });

    if (podFailed) {
      return res.status(422).json({ error: failureReason, output: logs });
    }

    res.json({ output: logs });
  } catch (err) {
    // Attempt to clean up the pod even if an error occurred elsewhere.
    await k8sApi.deleteNamespacedPod({ name: podName, namespace }).catch(e => {
       // Ignore 404 errors, as the pod may have already been deleted or never created.
       if (e.statusCode !== 404) {
         console.error("Failed to cleanup pod:", e.body?.message || e.message);
       }
    });

    console.error(err);
    const errorMessage = err.body?.message || err.message;
    res.status(500).json({ error: "Failed to run code", details: errorMessage });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});