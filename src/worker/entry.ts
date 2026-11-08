import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export default experimental_defineHostEntry({ contract: defineRpcContract({}), handlers: {} });
