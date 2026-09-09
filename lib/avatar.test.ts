import { describe, expect, it } from "vitest";
import { avatarAtIconSize } from "./avatar";

describe("asking for an avatar at guide size", () => {
  it("shrinks a YouTube avatar without disturbing the rest of the URL", () => {
    expect(
      avatarAtIconSize(
        "https://yt3.ggpht.com/ytc/AIdro_n5rV=s240-c-k-c0x00ffffff-no-rj",
      ),
    ).toBe("https://yt3.ggpht.com/ytc/AIdro_n5rV=s88-c-k-c0x00ffffff-no-rj");
  });

  it("shrinks a Twitch avatar and keeps its extension", () => {
    expect(
      avatarAtIconSize(
        "https://static-cdn.jtvnw.net/jtv_user_pictures/b3fc1f16-profile_image-300x300.png",
      ),
    ).toBe(
      "https://static-cdn.jtvnw.net/jtv_user_pictures/b3fc1f16-profile_image-70x70.png",
    );
  });

  it("leaves a URL it does not recognise exactly as it found it", () => {
    // Rewriting an unknown host's URL turns a working avatar into a 404.
    const other = "https://example.com/avatars/someone.png";
    expect(avatarAtIconSize(other)).toBe(other);
  });

  it("is idempotent, so a stored URL can be run through it twice", () => {
    const once = avatarAtIconSize(
      "https://yt3.ggpht.com/a=s240-c-k-c0x00ffffff-no-rj",
    );
    expect(avatarAtIconSize(once)).toBe(once);
  });

  it("does not mistake a size elsewhere in the path for the avatar size", () => {
    const url =
      "https://static-cdn.jtvnw.net/300x300/x-profile_image-300x300.jpeg";
    expect(avatarAtIconSize(url)).toBe(
      "https://static-cdn.jtvnw.net/300x300/x-profile_image-70x70.jpeg",
    );
  });
});
