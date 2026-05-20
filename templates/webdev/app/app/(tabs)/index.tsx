import { ScrollView, Text, View, TouchableOpacity } from "react-native";

import { ScreenContainer } from "@/components/screen-container";

export default function HomeScreen() {
  return (
    <ScreenContainer className="p-6">
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View className="flex-1 gap-8">
          <View className="gap-3">
            <Text className="text-4xl font-bold text-foreground">{{project_title}}</Text>
            <Text className="text-base text-muted leading-relaxed">
              A launch-ready mobile starter with a real first screen, clear action areas, and space for generated photos, field data, and customer workflows.
            </Text>
          </View>

          <View className="w-full bg-surface rounded-2xl p-6 shadow-sm border border-border gap-3">
            <Text className="text-lg font-semibold text-foreground">Today</Text>
            <Text className="text-sm text-muted leading-relaxed">
              Replace this card with the primary job, customer, task, or dashboard summary for the app you are building.
            </Text>
          </View>

          <View className="w-full bg-surface rounded-2xl p-6 shadow-sm border border-border gap-3">
            <Text className="text-lg font-semibold text-foreground">Media-ready</Text>
            <Text className="text-sm text-muted leading-relaxed">
              Use image and photo generation requests to create hero art, onboarding graphics, icons, or marketing assets for this app.
            </Text>
          </View>

          <View className="items-start">
            <TouchableOpacity className="bg-primary px-6 py-3 rounded-full active:opacity-80">
              <Text className="text-background font-semibold">Open workspace</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
