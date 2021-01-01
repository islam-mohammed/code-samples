import { Directive, Input, OnDestroy } from "@angular/core";
import { FormGroup, ValidatorFn, Validators } from "@angular/forms";
import { Store } from "@ngrx/store";
import { BaseComponent } from "@pnp/features/shared/ui";
import { FormService } from "../../../services";
import { FormState } from "../../../state";
import { IField, IFieldConfig } from "../../models/field.model";
import { TokenString } from "src/app/xplat/core/services/token-string";

/**
 * Base level abstraction for all form element components.
 */
@Directive()
export abstract class FormElementBaseComponent
  extends BaseComponent
  implements IField, OnDestroy {
  @Input()
  config: IFieldConfig;
  @Input()
  group: FormGroup;
  @Input()
  formService: FormService;

  protected constructor(protected store: Store<FormState.IFeatureState>) {
    super();
  }

  setRequired(
    validators?: Array<ValidatorFn>,
    targetFieldName?: string,
    forceMessage?: string
  ) {
    if (this.config) {
      if (
        forceMessage ||
        !this.config.validationMessages ||
        (this.config.validationMessages?.length === 0 && this.formService)
      ) {
        // if there is no validation message, add a proper message based on the placeholder
        this.config.validationMessages = [
          {
            type: "required",
            message:
              forceMessage ||
              `"${this.config?.placeholder || this.config?.label}:" ${
                TokenString.General.REQUIRED_LBL
              }`,
          },
        ];
      }
      this.setValidators(validators || [Validators.required], targetFieldName);
    }
  }

  setValidators(validators: Array<ValidatorFn>, targetFieldName?: string) {
    if (this.config && this.group) {
      const field = this.group.get(targetFieldName || this.config.name);
      if (field) {
        field.setValidators(validators);
        field.updateValueAndValidity();
      }
    }
  }

  clearValidators(hideField?: boolean) {
    if (this.config && this.group) {
      const field = this.group.get(this.config.name);
      if (field) {
        // clear validators
        field.setValidators(null);
      }

      this.updateValue(null);
      if (hideField) {
        // no parent value, hide this field
        this.config.hidden = true;
      }
    }
  }

  updateValue(value: any, targetFieldName?: string) {
    if (this.config && this.group) {
      const valueMatch: any = {};
      const fieldName = targetFieldName || this.config.name;
      if (fieldName) {
        valueMatch[fieldName] = value;
        this.group.patchValue(valueMatch, {
          emitEvent: true,
        });
      }
    }
  }

  // Updates this form value along with other dependent values in one patch call
  updateWithDependents(value: any, dependentKeyValues: any) {
    if (this.config && this.group) {
      const valueMatch = {};
      valueMatch[this.config.name] = value;
      for (const key in dependentKeyValues) {
        valueMatch[key] = dependentKeyValues[key];
      }
      this.group.patchValue(valueMatch, {
        emitEvent: true,
      });
    }
  }
}
