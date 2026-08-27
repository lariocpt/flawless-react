import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { listItems } from "../../lib/api";

/** Not exported: reachable only through its parent, so it gets no spec of its own. */
function ItemRow({ item, onPress }: { item: { id: string; name: string }; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="p-4">
      <Text className="text-lg">{item.name}</Text>
    </Pressable>
  );
}

export default function ItemsTab() {
  const router = useRouter();
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setBusy(true);
    const { items: next } = await listItems();
    setItems(next);
    setBusy(false);
  }

  return (
    <SafeAreaView className="flex-1">
      <View className="flex-row justify-between p-4">
        <Text className="text-2xl">Items</Text>
        {/* Addressable by its own literal text. */}
        <Pressable onPress={() => router.push("/items/new")} className="rounded-md px-3 py-2">
          <Text>Add</Text>
        </Pressable>
      </View>
      {/* Addressable only by testID — there is no text and no role. */}
      <Pressable onPress={reload} testID="reload" className="px-4">
        <Text>{busy ? "Loading" : "Reload"}</Text>
      </Pressable>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <ItemRow item={item} onPress={() => router.push(`/items/${item.id}`)} />
        )}
      />
    </SafeAreaView>
  );
}
