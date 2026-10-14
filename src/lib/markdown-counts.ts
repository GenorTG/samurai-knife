/** Link and image counts of the Markdown preview stats. Pure: unit-tested without React. */

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[[^\]]*\]\([^)]*\)/g;

/**
 * Inline links and inline images. An image is not also a link: images are counted and taken out first, so `![i](j)` is
 * one image and `[![i](j)](k)` (an image inside a link) is one image and one link. Reference-style syntax is not counted.
 */
export function countLinksAndImages(markdown: string): { links: number; images: number } {
  const images = markdown.match(IMAGE)?.length ?? 0;
  const links = markdown.replace(IMAGE, "IMG").match(LINK)?.length ?? 0;
  return { links, images };
}
