/**
 * The command that lists the resources behind an id prefix. Commands take ids, never slugs or
 * names, so an id that fails its shape check points the caller at the listing that shows the
 * right one. `<...>` marks an argument the listing needs; `commandPath` drops it.
 */
export const idListCommands: Readonly<Record<string, string>> = {
  org: "samva org list",
  key: "samva api-keys list",
  ns: "samva namespaces list",
  npl: "samva namespaces portal-links list <namespace-id>",
  contact: "samva contacts list",
  cgrp: "samva contact-groups list",
  conv: "samva conversations list",
  tmpl: "samva templates list",
  tproj: "samva templates list",
  tfam: "samva templates families list",
  sched: "samva scheduled-messages list",
  brand: "samva brands list",
  camp: "samva campaigns list",
  crun: "samva campaigns runs list <campaign-id>",
  jrny: "samva journeys list",
  jrun: "samva journeys runs list <journey-id>",
  wep: "samva webhooks list",
  dom: "samva email domains list",
  sender: "samva email senders list",
  supp: "samva suppressions list",
  nl: "samva newsletters list",
  tpc: "samva topics list",
  wasl: "samva whatsapp setup-links list",
  waflow: "samva whatsapp flows list",
  mbx: "samva mailboxes list",
  thread: "samva mailboxes threads <mailbox-id>",
  mbxact: "samva mailboxes actions list <mailbox-id>",
  agt: "samva agents list",
  ksrc: "samva knowledge list",
};

/** The command words of an {@link idListCommands} entry, without its `<argument>` placeholders. */
export const commandPath = (command: string): ReadonlyArray<string> =>
  command.split(" ").filter((word) => !word.startsWith("<"));

// An id-shape failure names its prefix in the example id or in the pattern it did not match.
const idShape = /\b([a-z]+)_(?:7q2xk9mvt4znw8rh|\[0-9a-hjkmnp-tv-z\])/;

/** The listing command for the id shape a validation message names, when one is known. */
export const idListGuidance = (message: string): string | undefined => {
  const prefix = idShape.exec(message)?.[1];
  return prefix === undefined ? undefined : idListCommands[prefix];
};
