import type { Profile } from "@/lib/cv/schema";

export type Bullet = Profile["experience"][number]["bullets"][number];
export type Experience = Profile["experience"][number];
