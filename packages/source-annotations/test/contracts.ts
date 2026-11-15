import type {
  AnnotationAuthor,
  AnnotationClient,
  AnnotationCreate,
  AnnotationExport,
  AnnotationList,
  AnnotationQuery,
  AnnotationUpdate,
  SourceAnnotation,
} from "@jpahd/source-annotations/contracts";

// Compile the emitted contracts with ES2022 only and no ambient type packages.
// This consumer can be shared by a browser/editor without Node or DOM globals.
export function bindClient(
  service: {
    list(cwd: string, query: AnnotationQuery): Promise<AnnotationList>;
    create(cwd: string, input: AnnotationCreate, author: AnnotationAuthor): Promise<SourceAnnotation>;
    update(cwd: string, input: AnnotationUpdate): Promise<SourceAnnotation>;
    delete(cwd: string, id: string, expectedRevision: number): Promise<{ deleted: true }>;
  },
  cwd: string,
  author: AnnotationAuthor,
): AnnotationClient {
  return {
    list: (query) => service.list(cwd, query),
    create: (input) => service.create(cwd, input, author),
    update: (input) => service.update(cwd, input),
    delete: ({ id, expectedRevision }) => service.delete(cwd, id, expectedRevision),
  };
}

export type PortableDocument = AnnotationExport;
