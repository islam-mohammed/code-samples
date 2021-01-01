import { OnInit, Directive } from '@angular/core';
import { select, Store } from '@ngrx/store';
import { UserRecipient, ValidationBlock, ValidationBlockType } from '@pnp/api';
import { isFallbackImage } from '@pnp/utils';
import { distinctUntilChanged, map, takeUntil } from 'rxjs/operators';
import { FormState } from '../../../state';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';

/**
 * Form picture abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class FormPictureBaseComponent extends FormElementBaseComponent implements OnInit {
  // the types of validations needed dynamically based on other form field references
  private _validateTypes: Array<string>;

  protected constructor(public store: Store<FormState.IFeatureState>) {
    super(store);
  }

  ngOnInit() {
    this.formService.validateTargetUpdate$.pipe(takeUntil(this.destroy$)).subscribe(update => {
      if (
        update.name === this.config.name &&
        (update.hasOwnProperty('checked') || update.hasOwnProperty('value') || update.hasOwnProperty('targetValues'))
      ) {
        let hidden = true;
        if (update.targetValues?.length) {
          hidden = !update.targetValues.includes(update.value);
        } else if (update.hasOwnProperty('checked')) {
          hidden = !parseInt(update.checked as any);
        } else {
          hidden = update.value !== this.config.value;
        }
        if (hidden) {
          this.clearValidators(true);
        } else if (['requiredIfNotEmpty', 'requiredIfValue'].includes(update.type)) {
          this.config.hidden = false;
          this.setRequired();
        }
      }
    });

    if (this.config) {
      if (this.config.name === 'pictureMain') {
        this.store
          .pipe(select(FormState.selectCurrentRecipient), distinctUntilChanged(), takeUntil(this.destroy$))
          .subscribe((selectedRecipient: UserRecipient) => {
            if (selectedRecipient?.data) {
              const pictureMain = selectedRecipient.data['pictureMain'];
              this.config.value = pictureMain; // for binding updates
              this.updateValue(pictureMain, 'pictureMain');
            }
          });
      }
      // dependent field validations
      if (Array.isArray(this.config.validateTargets) && this.config.validateTargets.length) {
        this._validateTypes = this.config.validateTargets.map(v => v.type);
        const validateRefs = this.config.validateTargets.map(v => v.reference);
        let valueChangeForRef = {};
        // first add valueChanges for this field
        this.group.valueChanges
          .pipe(
            map(formValue => formValue[this.config.name]),
            distinctUntilChanged(),
            takeUntil(this.destroy$)
          )
          .subscribe((value: any) => {
            if (value && this._validateTypes.includes('requiredIfNotEmpty')) {
              // valid value, ensure reference is also required
              this._updateReferenceRequired();
            }
          });
        for (const ref of validateRefs) {
          if (ref) {
            // now add valueChanges only once for all dependent field references
            if (!valueChangeForRef[ref]) {
              valueChangeForRef[ref] = true;
              this.group.valueChanges
                .pipe(
                  map(formValue => formValue[ref]),
                  distinctUntilChanged(),
                  takeUntil(this.destroy$)
                )
                .subscribe((value: any) => {
                  if (!value) {
                    // when reference field value is cleared and this field has a valid value, ensure it has a required validation
                    if (this.group && this._validateTypes.includes('requiredIfNotEmpty')) {
                      const field = this.group.get(this.config.name);
                      if (field?.value) {
                        // update reference required
                        this._updateReferenceRequired();
                      }
                    }
                  } else if (value && this._validateTypes.includes('requiredIfNotEmpty')) {
                    // reference has valid value, ensure this is required when reference is not empty
                    this.setRequired();
                    // ensure it has a valid required message
                    const hasRequiredMessage = this.config.validationMessages.find(v => {
                      return v.type === 'required';
                    });
                    if (!hasRequiredMessage) {
                      // borrow the message from the first
                      let message = '';
                      if (this.config.validationMessages.length) {
                        message = this.config.validationMessages[0].message;
                      }
                      this.config.validationMessages.push({
                        message,
                        type: 'required'
                      });
                    }
                  }
                });
            }
          }
        }
      }
    }
  }

  isDefaultUrl(url: string) {
    return isFallbackImage(url);
  }

  private _updateReferenceRequired() {
    if (this.config && Array.isArray(this.config.validateTargets)) {
      const isValidRef = this.config.validateTargets.find((v: ValidationBlock) => {
        return typeof this.group.controls[v.reference] !== 'undefined';
      });
      if (isValidRef) {
        const validateTarget = this.config.validateTargets.find((v: ValidationBlock) => {
          return v.type === ValidationBlockType.requiredIfEmpty;
        });
        if (validateTarget?.reference) {
          this.setRequired(null, validateTarget.reference);
          // update reference validation message
          this.formService.validateTargetUpdate$.next({
            errorMessage: validateTarget.errorMessage,
            name: validateTarget.reference,
            target: validateTarget.target,
            type: 'required',
            reference: validateTarget.reference
          });
        }
      }
    }
  }
}
