// A ROUTE file whose default export declares a function prop.
//
// expo-router hands a route screen no props, so this is not how anyone writes a
// screen — which is precisely why it had no fixture and why the defect stayed
// latent. The emitter still sees `onAction` as a prop-bound handler, and a route
// spec declares no `handlers` object (`const fnProps = route ? [] : …`), so it
// emitted `expect(handlers["onAction"]).toHaveBeenCalled()` against an
// identifier that is not there: TS2304 in the file, ReferenceError in the test.
//
// Kept as a fixture because "nobody writes this" is not the same as "the emitter
// may write something unbuildable for it".
import { Pressable, Text, View } from "react-native";

export default function PropsRoute({ onAction }: { onAction: () => void }) {
  return (
    <View>
      <Pressable accessibilityLabel="Do it" onPress={onAction}>
        <Text>Do it</Text>
      </Pressable>
    </View>
  );
}
