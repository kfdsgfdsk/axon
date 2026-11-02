/** Optional peer dependency — only needed when VAULT_KMS_PROVIDER=aws */
declare module '@aws-sdk/client-kms' {
  export class KMSClient {
    constructor(config?: object);
    send(command: unknown): Promise<any>;
  }
  export class EncryptCommand {
    constructor(input: object);
  }
  export class DecryptCommand {
    constructor(input: object);
  }
}
