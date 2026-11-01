import { Module, type DynamicModule } from "@nestjs/common";
import type { IdentityServices } from "../../identity/identity.module.js";
import { ProvenanceController } from "./provenance.controller.js";
import { ProvenanceService } from "./provenance.service.js";
@Module({})
export class ProvenanceModule {
  static forRoot(identity: IdentityServices): DynamicModule {
    return {
      module: ProvenanceModule,
      controllers: [ProvenanceController],
      providers: [
        {
          provide: ProvenanceService,
          useValue: new ProvenanceService(
            identity.principals,
            identity.secondFactors,
          ),
        },
      ],
    };
  }
}
