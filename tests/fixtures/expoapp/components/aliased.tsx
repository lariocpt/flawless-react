// An ALIASED api import. The mock emitter iterates the module's own export
// names while the classifiers read the component's subtree, where the LOCAL
// name appears — so this file is the one that keeps the two sides agreeing.
//
// With them out of step, `listItems` fell to a bare `{}` stub with no marker
// while the identical unaliased import got its real inferred shape, and the
// loaded-state test vanished along with the skip that should have explained it.
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { listItems as fetchItems } from "../lib/api";

export function Aliased() {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const run = async () => {
      const { items } = await fetchItems();
      setRows(items);
    };
    run();
  }, []);
  return (
    <View>
      {rows.map((r) => (
        <Text key={r.id}>{r.name}</Text>
      ))}
    </View>
  );
}
