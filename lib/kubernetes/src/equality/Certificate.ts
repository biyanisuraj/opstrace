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

import { log } from "@opstrace/utils";
import { isDeepStrictEqual } from "util";
import { V1CertificateResource } from "../custom-resources";

export const isCertificateEqual = (
  desired: V1CertificateResource,
  existing: V1CertificateResource
): boolean => {
  if (typeof desired.spec !== typeof existing.spec) {
    return false;
  }

  if (
    !isDeepStrictEqual(
      desired.spec.metadata!.annotations,
      existing.spec.metadata!.annotations
    )
  ) {
    log.debug(
      `annotations mismatch:  ${JSON.stringify(
        desired.spec.metadata!.annotations
      )} vs ${existing.spec.metadata!.annotations}`
    );
    return false;
  }

  if (desired.spec.spec.commonName !== existing.spec.spec.commonName) {
    log.debug(
      `commonName mismatch:  ${desired.spec.spec.commonName} vs ${existing.spec.spec.commonName}`
    );
    return false;
  }

  if (
    !isDeepStrictEqual(desired.spec.spec.dnsNames, existing.spec.spec.dnsNames)
  ) {
    log.debug(
      `dnsNames mismatch:  ${desired.spec.spec.dnsNames} vs ${existing.spec.spec.dnsNames}`
    );
    return false;
  }

  if (desired.spec.spec.isCA !== existing.spec.spec.isCA) {
    log.debug(
      `isCA mismatch:  ${desired.spec.spec.isCA} vs ${existing.spec.spec.isCA}`
    );
    return false;
  }

  if (
    !isDeepStrictEqual(
      desired.spec.spec.issuerRef,
      existing.spec.spec.issuerRef
    )
  ) {
    log.debug(
      `issuerRef mismatch:  ${desired.spec.spec.issuerRef} vs ${existing.spec.spec.issuerRef}`
    );
    return false;
  }

  if (desired.spec.spec.secretName !== existing.spec.spec.secretName) {
    log.debug(
      `secretName mismatch:  ${desired.spec.spec.secretName} vs ${existing.spec.spec.secretName}`
    );
    return false;
  }

  return true;
};
