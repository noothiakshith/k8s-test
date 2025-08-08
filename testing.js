import express from "express"
const app = express()
import * as k8s from "@kubernetes/client-node";
app.use(express.json())
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

app.post('/run-code',async(req,res,next)=>{
    const {languagee,code} = req.body;
     const podName = `code-runner-${Date.now()}`;
     const namespace = "codespaces";
     
  const podManifest = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: namespace,
    },
    spec: {
      containers: [
        {
          name: "runner",
          image:
            languagee === "python"
              ? "python:3.11"
              : language === "node"
              ? "node:22"
              : "alpine",
          command:
            languagee === "python"
              ? ["python", "-c", code]
              : language === "node"
              ? ["node", "-e", code]
              : ["sh", "-c", code],
        },
      ],
      restartPolicy: "Never",
    },
  };
  try{
    const createdpod = await k8sApi.createNamespacedPod({
        namespace,
        body:podManifest
    });
    console.log('created')
  }
  catch(err){
    console.log(err)
  }
})