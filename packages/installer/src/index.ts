/**
 * Copyright 2020 Opstrace, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { strict as assert } from "assert";

import got, { Response as GotResponse, Options as GotOptions } from "got";
import { fork, call, race, delay, cancel } from "redux-saga/effects";
import { createStore, applyMiddleware } from "redux";
import createSagaMiddleware from "redux-saga";

import {
  log,
  sleep,
  SECOND,
  die,
  retryUponAnyError,
  Dict
} from "@opstrace/utils";

import {
  getTenantsConfig,
  getFirewallConfig,
  getClusterConfig,
  getDnsConfig,
  NewRenderedClusterConfigType
} from "@opstrace/config";

import { getKubeConfig, k8sListNamespacesOrError } from "@opstrace/kubernetes";

import {
  getValidatedGCPAuthOptionsFromFile,
  GCPAuthOptions
} from "@opstrace/gcp";
import { getCertManagerRoleArn } from "@opstrace/aws";
import { set as updateTenantsConfig } from "@opstrace/tenants";
import {
  set as updateControllerConfig,
  ControllerConfigType,
  controllerConfigSchema
} from "@opstrace/controller-config";
import { deployControllerResources } from "@opstrace/controller";

import { rootReducer } from "./reducer";
import { ensureGCPInfraExists } from "./gcp";
import {
  ensureAWSInfraExists,
  waitUntilRoute53EntriesAreAvailable
} from "./aws";
import { ClusterCreateTimeoutError } from "./errors";
import { runInformers } from "./informers";
import {
  installationProgressReporter,
  waitForControllerDeployment
} from "./readiness";
import { storeSystemTenantApiAuthTokenAsSecret } from "./secrets";

// GCP-specific cluster creation code can rely on this being set. First I tried
// to wrap this into the non-user-given cluster config schema but then realized
// that this is _part_ of credentials, and really just some detail parameter
// used at runtime that has little to do with "config": users provide svc acc
// credentials and these implicitly define the gcp project ID.
let gcpProjectID: string;
export function setGcpProjectID(p: string) {
  gcpProjectID = p;
}
export { gcpProjectID };

// configuration for the cluster creation process which does _not_ belong
// semantically to the cluster config itself.
export interface ClusterCreateConfigInterface {
  holdController: boolean;
  tenantApiTokens: Dict<string>; // tenant name : api token map, can be empty
}

let clusterCreateConfig: ClusterCreateConfigInterface;
export function setCreateConfig(c: ClusterCreateConfigInterface) {
  clusterCreateConfig = c;
}

// number of Opstrace cluster creation attempts
const CREATE_ATTEMPTS = 3;

// timeout per attempt
const CREATE_ATTEMPT_TIMEOUT_SECONDS = 60 * 40;

function* createClusterCore() {
  const ccfg: NewRenderedClusterConfigType = getClusterConfig();

  const gcpCredFilePath: string = process.env[
    "GOOGLE_APPLICATION_CREDENTIALS"
  ]!;

  const firewallConf = getFirewallConfig({
    api: ccfg.data_api_authorized_ip_ranges
  });
  const retentionConf = {
    logs: ccfg.log_retention_days,
    metrics: ccfg.metric_retention_days
  };

  let gcpAuthOptions: GCPAuthOptions | undefined;

  // not sure why the controller needs to know about 'region', but here we go.
  let region: string;

  if (ccfg.cloud_provider === "gcp") {
    // note: legacy, tmp state, when we are in this routine the
    // GOOGLE_APPLICATION_CREDENTIALS env variable is set to an existing file,
    // and basic content validation has already been performed. details from
    // the file, such as project ID, will be set on global config object. this
    // is only here to keep following code working w/o change.
    gcpAuthOptions = getValidatedGCPAuthOptionsFromFile(gcpCredFilePath);

    if (ccfg.gcp === undefined) {
      throw Error("`gcp` property expected");
    }

    region = ccfg.gcp.region;
  } else {
    assert(ccfg.cloud_provider === "aws");

    if (ccfg.aws === undefined) {
      throw Error("`aws` property expected");
    }

    // set `region` (legacy code maintenance, clean up)
    region = ccfg.aws.region;
  }

  const dnsConf = getDnsConfig(ccfg.cloud_provider);

  // Fail fast if specified controller docker image cannot be found on docker
  // hub, see opstrace-prelaunch/issues/1298.
  const controllerConfig: ControllerConfigType = {
    name: ccfg.cluster_name,
    version: "notneededanymore",
    target: ccfg.cloud_provider,
    region: region, // not sure why that's needed
    cert_issuer: ccfg.cert_issuer,
    gcpAuthOptions,
    infrastructureName: ccfg.cluster_name,
    logRetention: retentionConf.logs,
    metricRetention: retentionConf.metrics,
    dnsName: dnsConf.dnsName,
    authenticationCookie:
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15),
    terminate: false,
    controllerTerminated: false,
    tlsCertificateIssuer: ccfg.cert_issuer,
    uiSourceIpFirewallRules: firewallConf.ui,
    apiSourceIpFirewallRules: firewallConf.api,
    oidcClientId:
      "492745505745-sdef5ljea5pqjn3mg6499r66aifgl4le.apps.googleusercontent.com",
    oidcClientSecret: "b6rPEc0tnv8tZyc0eN8xpz1h",
    data_api_authn_pubkey_pem: ccfg.data_api_authn_pubkey_pem,
    disable_data_api_authentication: ccfg.data_api_authentication_disabled
  };

  log.debug("validate controller config");

  // "Strict schemas skip coercion and transformation attempts, validating the value "as is"."
  // This is mainly to error out upon unexpected parameters: to 'enforce' yup's
  // noUnknown, see
  // https://github.com/jquense/yup/issues/829#issuecomment-606030995
  // https://github.com/jquense/yup/issues/697
  controllerConfigSchema.validateSync(controllerConfig, { strict: true });

  if (!clusterCreateConfig.holdController) {
    yield call(checkIfDockerImageExistsOrErrorOut, ccfg.controller_image);
  }

  let kubeconfigString = "";
  if (ccfg.cloud_provider === "gcp") {
    kubeconfigString = yield call(ensureGCPInfraExists, gcpAuthOptions!);
  }
  if (ccfg.cloud_provider === "aws") {
    kubeconfigString = yield call(ensureAWSInfraExists);

    controllerConfig.aws = {
      certManagerRoleArn: getCertManagerRoleArn()
    };
  }

  if (!kubeconfigString) {
    throw Error("couldn't compute a kubeconfig");
  }

  const kubeConfig = getKubeConfig({
    loadFromCluster: false,
    kubeconfig: kubeconfigString
  });

  // Try to interact with the k8s API (for debugging, kept from legacy code)
  try {
    yield call(k8sListNamespacesOrError, kubeConfig);
  } catch (err) {
    log.warning(
      "problem when interacting with the k8s cluster (thrown by k8sListNamespacesOrError): %s",
      err
    );
  }

  const tenantsConfig = getTenantsConfig(ccfg.tenants);
  yield call(updateControllerConfig, controllerConfig, kubeConfig);
  yield call(updateTenantsConfig, tenantsConfig, kubeConfig);

  let systemTenantAuthToken = clusterCreateConfig.tenantApiTokens["system"];

  // Always deploy secret (so that the systemlog deployment config does not
  // depend on whether or not this is set). Just set a dummy value in case
  // tenant API authentication is disabled.
  if (systemTenantAuthToken === undefined) {
    assert(ccfg.data_api_authentication_disabled);
    systemTenantAuthToken = "not-required";
  }

  yield call(
    storeSystemTenantApiAuthTokenAsSecret,
    systemTenantAuthToken,
    kubeConfig
  );

  if (clusterCreateConfig.holdController) {
    log.info(
      `Not deploying controller. Raw cluster creation finished: ${ccfg.cluster_name} (${ccfg.cloud_provider})`
    );
    return;
  }

  log.info("deploying controller");
  yield call(deployControllerResources, {
    controllerImage: ccfg.controller_image,
    opstraceClusterName: ccfg.cluster_name,
    kubeConfig
  });

  log.info("starting k8s informers");
  const informers = yield fork(runInformers, kubeConfig);

  yield call(waitForControllerDeployment);

  yield call(installationProgressReporter);

  // `informers` is a so-called attached fork. Cancel this task.
  yield cancel(informers);

  if (ccfg.cloud_provider == "aws") {
    yield call(
      waitUntilRoute53EntriesAreAvailable,
      ccfg.cluster_name,
      ccfg.tenants
    );
  }

  yield call(
    waitUntilLokiCortexAreReachable,
    ccfg.cluster_name,
    ccfg.tenants,
    ccfg.cloud_provider
  );

  log.info(
    `cluster creation finished: ${ccfg.cluster_name} (${ccfg.cloud_provider})`
  );
}

/**
 * Confirm DNS-reachability, and also readiness of deployments. k8s
 * cluster-internal readiness wasn't always enough, see opstrace-prelaunch/issues/1245 and related
 * issues.
 */
export async function waitUntilLokiCortexAreReachable(
  opstraceClusterName: string,
  tenantNames: string[],
  cloudProvider: "gcp" | "aws"
) {
  // key: unique url, value: corresponding tenant name
  const probeUrls: Dict<string> = {};

  // system tenant is there by default, check corresponding endpoints, too
  const tnames = [...tenantNames];
  tnames.push("system");

  for (const tname of tnames) {
    const mid = `${tname}.${opstraceClusterName}.opstrace.io`;
    // opstrace-prelaunch/issues/1570
    probeUrls[`https://cortex.${mid}/api/v1/labels`] = tname;
    probeUrls[`https://loki.${mid}/loki/api/v1/labels`] = tname;
  }

  const requestSettings: GotOptions = {
    throwHttpErrors: false,
    retry: 0,
    https: { rejectUnauthorized: false },
    timeout: {
      connect: 3000,
      request: 10000
    }
  };

  async function wait(probeUrl: string, tenantName: string) {
    let attempt = 0;
    while (true) {
      attempt++;

      // Copy common request settings, add authentication proof if required.
      const rs: GotOptions = { ...requestSettings };
      const tenantAuthToken = clusterCreateConfig.tenantApiTokens[tenantName];
      if (tenantAuthToken !== undefined) {
        rs.headers = { Authorization: `Bearer ${tenantAuthToken}` };
      }

      let resp: GotResponse<string>;
      try {
        //@ts-ignore `got(probeUrl, rs)` returns `unknown` from tsc's point of view
        resp = await got(probeUrl, rs);
      } catch (e) {
        if (e instanceof got.RequestError) {
          // Assume that for most of the 'waiting time' the probe fails in this
          // error handler.

          // When the debug log level is active then I think it's the right
          // thing to log every negative probe outcome as it happens (e.g. DNS
          // resolution error or TCP connection timeout).
          log.debug(`${probeUrl}: HTTP request failed with: ${e.message}`);

          // But on info level just emit the fact that the expected outcome is
          // still being waited for, every now and then (maybe every ~20
          // seconds).
          if (attempt % 5 === 0) {
            log.info(
              `${probeUrl}: still waiting for expected signal. Last error: ${e.message}`
            );
          }

          await sleep(5.0);
          continue;
        } else {
          throw e;
        }
      }

      if (resp.statusCode == 200) {
        let data: any;
        try {
          data = JSON.parse(resp.body);
        } catch (err) {
          log.debug(`${probeUrl}: JSON deserialization err: ${err.message}`);
        }

        if (data && data.status !== undefined) {
          if (data.status == "success") {
            log.info(`${probeUrl}: got expected HTTP response`);
            return;
          }
          log.info(`${probeUrl}: JSON doc 'status': ${data.status}`);
        }
      }

      log.debug(`HTTP response details:
  status: ${resp.statusCode}
  body[:500]: ${resp.body.slice(0, 500)}`);

      if (attempt % 2 === 0) {
        log.info(`${probeUrl}: still waiting, unexpected HTTP response`);
      }

      await sleep(5.0);
    }
  }

  log.info(
    "waiting for expected HTTP responses at these URLs: %s",
    JSON.stringify(probeUrls, null, 2)
  );
  const actors = [];
  for (const [probeUrl, tenantName] of Object.entries(probeUrls)) {
    actors.push(wait(probeUrl, tenantName));
  }
  await Promise.all(actors);
  log.info("All probe URLs returned expected HTTP responses, continue");
}

/**
 * Timeout control around a single cluster creation attempt.
 */
function* createClusterAttemptWithTimeout() {
  log.debug("createClusterAttemptWithTimeout");
  const { timeout } = yield race({
    create: call(createClusterCore),
    timeout: delay(CREATE_ATTEMPT_TIMEOUT_SECONDS * SECOND)
  });

  if (timeout) {
    // Note that in this case redux-saga guarantees to have cancelled the
    // task(s) that lost the race, i.e. the `create` task above.
    log.warning(
      "cluster creation attempt timed out after %s seconds",
      CREATE_ATTEMPT_TIMEOUT_SECONDS
    );
    throw new ClusterCreateTimeoutError();
  }
}

function* rootTaskCreate() {
  yield call(retryUponAnyError, {
    task: createClusterAttemptWithTimeout,
    maxAttempts: CREATE_ATTEMPTS,
    doNotLogDetailForTheseErrors: [ClusterCreateTimeoutError],
    actionName: "cluster creation",
    delaySeconds: 10
  });
}

/**
 * Entry point for cluster creation, to be called by CLI.
 */
export async function createCluster(
  smOnError: (e: Error, detail: any) => void
) {
  const sm = createSagaMiddleware({ onError: smOnError });

  createStore(rootReducer, applyMiddleware(sm));
  await sm.run(rootTaskCreate).toPromise();

  // this is helpful when the runtime is supposed to crash but doesn't
  log.debug("end of createCluster()");
}

/**
 * Check if docker image exists on docker hub. `imageName` is expected to
 * define both the repository and the image tag, separated with a colon.
 *
 * Exit process when image name does not satisfy that requirement or when image
 * does not exist.
 *
 * Note: this is just a pragmatic check trying to help with a workflow trap,
 * may want to allow for overriding this check. Also, upon umbiguous signal
 * (not one of 200 or 404 reponse) do not error out.
 */
async function checkIfDockerImageExistsOrErrorOut(imageName: string) {
  log.info("check if docker image exists on docker hub: %s", imageName);
  const splits = imageName.split(":");
  if (splits.length != 2) {
    die("unexpected controller image name");
  }
  const repo = splits[0];
  const imageTag = splits[1];

  const probeUrl = `https://hub.docker.com/v2/repositories/${repo}/tags/${imageTag}/`;
  const requestSettings = {
    throwHttpErrors: false,
    retry: 3,
    timeout: {
      connect: 3000,
      request: 10000
    }
  };

  let resp: GotResponse<string> | GotResponse<Buffer> | undefined;

  try {
    resp = await got(probeUrl, requestSettings);
  } catch (e) {
    if (e instanceof got.RequestError) {
      log.info(
        `could not detect presence of docker image: ${e.message} -- ignored, proceed`
      );
      return;
    } else {
      throw e;
    }
  }

  if (resp && resp.statusCode == 404) {
    die(
      "docker image not present on docker hub: you might want to push that first"
    );
  }

  if (resp && resp.statusCode == 200) {
    log.info("docker image present on docker hub, continue");
    return;
  }

  log.info("unexpected response, ignore");
  log.debug("respo status code: %s", resp.statusCode);

  if (resp.body) {
    // `slice()` works regardless of Buffer or string.
    let bodyPrefix = resp.body.slice(0, 500);
    // If buffer: best-effort decode the buffer into text (this method does _not_
    // not blow up upon unexpected byte sequences).
    if (Buffer.isBuffer(bodyPrefix)) bodyPrefix = bodyPrefix.toString("utf-8");
    log.debug(`response body, first 500 bytes: ${bodyPrefix}`);
  }
}
